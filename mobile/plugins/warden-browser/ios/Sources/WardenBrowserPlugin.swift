import Capacitor
import UIKit

/**
 The bridge to WARDEN's own browser surface.

 The shell used to hand every address to `SFSafariViewController`, which is a
 separate app's UI: the operator could not see where they were in WARDEN, and
 WARDEN's answer to "what am I looking at" was a system screen it does not
 control. This presents a `WKWebView` with chrome of our own — an editable
 address field, back, forward, reload — inside the app.

 The session is in memory only (`nonPersistent()`), which is the same posture the
 desktop product states: nothing is written to disk, and closing the surface
 discards it.
 */
@objc(WardenBrowserPlugin)
public class WardenBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WardenBrowserPlugin"
    public let jsName = "WardenBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    /// The surface that is up, so a second `open` replaces it rather than
    /// stacking another browser behind this one.
    private weak var presented: WardenBrowserViewController?

    @objc func open(_ call: CAPPluginCall) {
        guard let raw = call.getString("url")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
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

            let browser = WardenBrowserViewController(startURL: url)
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
}
