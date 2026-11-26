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
        CAPPluginMethod(name: "clearServiceData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "siteRules", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetSiteRules", returnType: CAPPluginReturnPromise)
    ]

    /// A capture waits on a page load; a stalled one must not hang the shell.
    private static let captureTimeout: TimeInterval = 30

    /// The surface that is up, so a second `open` replaces it rather than
    /// stacking another browser behind this one.
    private weak var presented: WardenBrowserViewController?

    /// The `warden://` observer, so a screen can be asked for from outside the
    /// app. AppDelegate announces the address; this hands it to the shell, which
    /// decides what it means.
    private var tourObserver: NSObjectProtocol?

    override public func load() {
        tourObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("warden.captureTour"),
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?["url"] as? String else { return }
            self?.notifyListeners("tour", data: ["url": raw])
        }
    }

    deinit {
        if let tourObserver {
            NotificationCenter.default.removeObserver(tourObserver)
        }
    }

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

        // iOS keeps a call alive with a property; Android spells the same thing
        // as a setter. The capture resolves minutes after this returns, so the
        // bridge has to hold the call until then.
        call.keepAlive = true
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

    /**
     The per-site rules the browser has been given, so Policy can show them.

     The switches live on the surface's shield sheet, where the operator is
     looking at the site; this is the read-only view the shell needs to state
     what is in force, and to end them all at once.
     */
    @objc func siteRules(_ call: CAPPluginCall) {
        call.resolve(["rules": WardenPolicy.shared.rules()])
    }

    /// Forget every site rule — blocking back on, cookies refused, everywhere.
    @objc func forgetSiteRules(_ call: CAPPluginCall) {
        WardenPolicy.shared.forgetAll()
        call.resolve()
    }

    /// Close the surface that is up, if any.
    ///
    /// `scry` reads the surface it finds on screen rather than reloading the
    /// same address, which is right when an operator is looking at the page. It
    /// is wrong when the next screen is the report: the shell cannot show one
    /// behind a browser it did not close, and the screenshot capture asks for
    /// exactly that screen.
    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let browser = self.presented else {
                call.resolve()
                return
            }
            browser.dismiss(animated: false) {
                self.presented = nil
                call.resolve()
            }
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
