import Capacitor
import UIKit
import WebKit

/**
 The bridge to WARDEN's own browser surface.

 The shell used to hand every address to `SFSafariViewController`, which is a
 separate app's UI: the operator could not see where they were in WARDEN, and
 WARDEN's answer to "what am I looking at" was a system screen it does not
 control. This presents a `WKWebView` with chrome of our own — an editable
 address field, back, forward, reload — inside the app.

 The session is in memory only (`nonPersistent()`) for the browser, which is the
 same posture the desktop product states: nothing is written to disk, and closing
 the surface discards it. A *service* surface — chat or mail — uses the default
 store instead, so it is still signed in next time, and `clearServiceData` is the
 one wipe that ends those sessions.
 */
@objc(WardenBrowserPlugin)
public class WardenBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WardenBrowserPlugin"
    public let jsName = "WardenBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openService", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearServiceData", returnType: CAPPluginReturnPromise)
    ]

    /// A capture waits on a page load; a stalled one must not hang the shell.
    private static let captureTimeout: TimeInterval = 30

    /// The surface that is up, so a second `open` replaces it rather than
    /// stacking another browser behind this one.
    private weak var presented: WardenBrowserViewController?

    @objc func open(_ call: CAPPluginCall) {
        present(call, session: .privateMode)
    }

    @objc func openService(_ call: CAPPluginCall) {
        present(call, session: .service)
    }

    /// Read the page at `url` and hand the report back; nothing is left open.
    @objc func scry(_ call: CAPPluginCall) {
        guard let script = call.getString("script"), !script.isEmpty else {
            call.reject("A capture script is required")
            return
        }
        guard let url = requestedURL(call) else {
            call.reject("A http or https url is required")
            return
        }

        call.setKeepAlive(true)
        var settled = false
        let finish: (String?) -> Void = { text in
            guard !settled else { return }
            settled = true
            call.resolve(["capture": text ?? "{}"])
        }

        // A timeout is a rejection, not an empty report: an absent report and a
        // report of nothing look identical on screen and are not the same thing.
        DispatchQueue.main.asyncAfter(deadline: .now() + WardenBrowserPlugin.captureTimeout) { [weak call] in
            guard !settled else { return }
            settled = true
            call?.reject("The capture timed out before the page finished loading.")
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let host = self.bridge?.viewController else {
                finish(nil)
                return
            }
            // A surface already on screen is captured where it is: dismissing the
            // page the operator is reading to reopen the same address would be a
            // visible reload for no gain.
            if let existing = self.presented {
                existing.capture(script, completion: finish)
                return
            }
            let browser = WardenBrowserViewController(startURL: url, captureScript: script)
            browser.onEvent = { [weak self] name, payload in
                self?.notifyListeners(name, data: payload)
            }
            browser.onCapture = finish
            browser.onDismiss = { [weak self] in
                self?.presented = nil
                self?.notifyListeners("closed", data: [:])
            }
            self.presented = browser
            host.present(browser, animated: true, completion: nil)
        }
    }

    /// Sign out of every service, without touching the browser's session.
    @objc func clearServiceData(_ call: CAPPluginCall) {
        let store = WKWebsiteDataStore.default()
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
            call.resolve()
        }
    }

    private func present(_ call: CAPPluginCall, session: WardenBrowserViewController.Session) {
        guard let url = requestedURL(call) else {
            call.reject("A http or https url is required")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let host = self.bridge?.viewController else {
                call.reject("No view controller to present from")
                return
            }
            if let existing = self.presented {
                existing.load(url)
                call.resolve()
                return
            }

            let browser = WardenBrowserViewController(startURL: url, session: session)
            browser.onEvent = { [weak self] name, payload in
                self?.notifyListeners(name, data: payload)
            }
            browser.onDismiss = { [weak self] in
                self?.presented = nil
                self?.notifyListeners("closed", data: [:])
            }
            self.presented = browser
            host.present(browser, animated: true) {
                call.resolve()
            }
        }
    }

    /// `http` and `https` only: anything else belongs to the system, not here.
    private func requestedURL(_ call: CAPPluginCall) -> URL? {
        guard let raw = call.getString("url")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }
}
