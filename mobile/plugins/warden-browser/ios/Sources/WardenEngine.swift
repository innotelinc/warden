import Foundation
import WebKit

/**
 WARDEN's browser policy: the layer above the renderer.

 Apple requires every browser distributed through the App Store to render with
 WebKit, which is the same engine Chrome, Firefox and Edge ship on iOS. There is
 no embeddable storage build of Blink or Gecko to link against, so "our own
 browser" cannot mean our own renderer — it means everything above it, and that
 is what this file owns:

 - which requests are refused, from WARDEN's own lists, compiled into a content
   rule list and applied before the page's scripts run;
 - whether a host keeps cookies, and the purge that clears the ones it should
   not have;
 - the fingerprint shim injected before any site script;
 - the `document.cookie` lock for hosts that have no allowance;
 - the reader extraction and the own error page the surface shows instead of
   WebKit's.

 The renderer is Apple's. The policies are ours, and every one of them is named
 on the Policy screen rather than implied.
 */

// MARK: - Site policy

/**
 Per-host switches, for the life of the app.

 In memory on purpose: a rule set that survives a quit is a profile, and this
 product does not keep one. "Forget all site rules" and quitting do the same
 thing to this store.
 */
final class WardenPolicy {
    static let shared = WardenPolicy()

    private var blockingOff: Set<String> = []
    private var cookieAllowed: Set<String> = []

    private init() {}

    /// Host names are compared lowercased and without a port; `www.` is kept,
    /// because `www.example.com` and `example.com` are two allowlist decisions
    /// on the desktop as well.
    static func host(_ url: URL?) -> String {
        (url?.host ?? "").lowercased()
    }

    func isBlocking(_ host: String) -> Bool {
        !blockingOff.contains(host)
    }

    func setBlocking(_ host: String, _ on: Bool) {
        guard !host.isEmpty else { return }
        if on {
            blockingOff.remove(host)
        } else {
            blockingOff.insert(host)
        }
    }

    func allowsCookies(_ host: String) -> Bool {
        cookieAllowed.contains(host)
    }

    func setCookies(_ host: String, _ on: Bool) {
        guard !host.isEmpty else { return }
        if on {
            cookieAllowed.insert(host)
        } else {
            cookieAllowed.remove(host)
        }
    }

    func allowedCookieHosts() -> [String] {
        Array(cookieAllowed).sorted()
    }

    /// Every host with a rule, so Policy can show them and the operator can end
    /// them all at once.
    func rules() -> [[String: Any]] {
        var hosts = blockingOff.union(cookieAllowed)
        return hosts.sorted().map { host in
            [
                "host": host,
                "blocking": isBlocking(host),
                "cookies": allowsCookies(host)
            ]
        }
    }

    func forgetAll() {
        blockingOff.removeAll()
        cookieAllowed.removeAll()
    }
}

// MARK: - Scripts

enum WardenScripts {

    /**
     The fingerprint shim, mirroring the desktop's `hardening.ts`.

     Values are generic rather than randomised: a unique-per-session value is
     itself a fingerprint, so the goal is to land in the largest crowd the
     engine can produce, not to be different every time.
     */
    static let fingerprint = """
    (function () {
      if (window.__wardenHardened) return;
      Object.defineProperty(window, '__wardenHardened', { value: true, enumerable: false });

      function define(obj, prop, getter) {
        try {
          Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true });
        } catch (error) {}
      }

      define(Navigator.prototype, 'hardwareConcurrency', function () { return 4; });
      define(Navigator.prototype, 'deviceMemory', function () { return 8; });
      define(Navigator.prototype, 'webdriver', function () { return false; });
      define(Navigator.prototype, 'plugins', function () { return []; });
      define(Navigator.prototype, 'mimeTypes', function () { return []; });
      define(Navigator.prototype, 'languages', function () { return ['en-US', 'en']; });
      define(Navigator.prototype, 'doNotTrack', function () { return '1'; });
      define(Navigator.prototype, 'globalPrivacyControl', function () { return true; });

      try {
        if (navigator.connection) {
          define(navigator.connection, 'effectiveType', function () { return '4g'; });
          define(navigator.connection, 'rtt', function () { return 50; });
          define(navigator.connection, 'downlink', function () { return 10; });
        }
      } catch (error) {}

      try {
        define(screen, 'width', function () { return 390; });
        define(screen, 'height', function () { return 844; });
        define(screen, 'availWidth', function () { return 390; });
        define(screen, 'availHeight', function () { return 844; });
        define(screen, 'colorDepth', function () { return 24; });
        define(screen, 'pixelDepth', function () { return 24; });
      } catch (error) {}

      try {
        var toDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function () {
          try {
            var context = this.getContext('2d');
            if (context) {
              var data = context.getImageData(0, 0, Math.min(this.width, 96), Math.min(this.height, 96));
              for (var i = 0; i < data.data.length; i += 4) {
                data.data[i] = data.data[i] ^ 1;
              }
              context.putImageData(data, 0, 0);
            }
          } catch (error) {}
          return toDataURL.apply(this, arguments);
        };
      } catch (error) {}

      try {
        var getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
          if (param === 0x9245) { return 'Generic Graphics'; }
          if (param === 0x9246 || param === 0x1f01) { return 'ANGLE (Generic Renderer)'; }
          if (param === 0x1f00) { return 'WebKit'; }
          return getParameter.apply(this, arguments);
        };
      } catch (error) {}
    })();
    """

    /**
     The cookie lock.

     The store is non-persistent, so nothing outlives the surface; this is the
     second half of the desktop's promise — a site that is not allowed cannot
     create a cookie *at all*, including from JavaScript, and `cookieStore` is
     removed so there is no way back in.
     */
    static func cookieLock(allowed: [String]) -> String {
        let list = allowed.map { "\"\($0.replacingOccurrences(of: "\"", with: "\\\""))\"" }.joined(separator: ", ")
        return """
        (function () {
          var allowed = [\(list)];
          var host = (location.hostname || '').toLowerCase();
          for (var i = 0; i < allowed.length; i += 1) {
            var entry = allowed[i];
            if (host === entry || host.slice(-entry.length - 1) === '.' + entry) return;
          }
          try {
            Object.defineProperty(document, 'cookie', {
              configurable: false,
              get: function () { return ''; },
              set: function () { return true; }
            });
          } catch (error) {}
          try { delete Document.prototype.cookieStore; } catch (error) {}
          try { Object.defineProperty(Document.prototype, 'cookieStore', { value: undefined }); } catch (error) {}
        })();
        """
    }

    /**
     Reader extraction.

     Runs after the page settles and returns a JSON string — the same shape the
     capture script uses, because both are evaluated by `evaluateJavaScript` and
     both have to survive the trip.
     */
    static let reader = """
    (function () {
      function text(node) {
        return (node && node.textContent ? node.textContent : '').replace(/\\s+/g, ' ').trim();
      }
      var candidates = [
        document.querySelector('article'),
        document.querySelector('[role="main"]'),
        document.querySelector('main'),
        document.body
      ];
      var best = null;
      var bestScore = 0;
      for (var i = 0; i < candidates.length; i += 1) {
        var node = candidates[i];
        if (!node) continue;
        var score = text(node).length;
        if (score > bestScore) { best = node; bestScore = score; }
      }
      if (!best || bestScore < 400) {
        return JSON.stringify({ error: 'No article on this page to read.' });
      }
      var clone = best.cloneNode(true);
      var strip = clone.querySelectorAll('script, style, nav, aside, form, iframe, noscript, [aria-hidden="true"]');
      for (var j = 0; j < strip.length; j += 1) {
        if (strip[j].parentNode) strip[j].parentNode.removeChild(strip[j]);
      }
      return JSON.stringify({
        title: document.title || '',
        url: location.href,
        html: clone.innerHTML
      });
    })();
    """

    /// The error page, in the app's own voice rather than WebKit's.
    static func errorPage(url: String, message: String) -> String {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { margin: 0; padding: 28px 22px; background: #070a0d; color: #dbe5f1;
                 font: 15px/1.6 -apple-system, system-ui, sans-serif; }
          h1 { font-size: 16px; letter-spacing: 0.02em; margin: 0 0 6px; }
          p { color: #7b8a9d; margin: 0 0 14px; }
          code { font: 12px/1.5 ui-monospace, monospace; color: #4fe3c1; word-break: break-all; }
          .tag { display: inline-block; font: 10px/1 ui-monospace, monospace; letter-spacing: 0.16em;
                 text-transform: uppercase; color: #f5b95b; border: 1px solid rgba(245,185,91,0.35);
                 border-radius: 4px; padding: 4px 6px; margin-bottom: 14px; }
        </style></head><body>
        <div class="tag">warden</div>
        <h1>This page did not load</h1>
        <p>\(escaped)</p>
        <code>\(url)</code>
        </body></html>
        """
    }

    /// The reader's own page: no script, no network, no remote styles.
    static func readerDocument(title: String, html: String, url: String) -> String {
        """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { margin: 0 auto; padding: 24px 20px 60px; max-width: 680px; background: #0a0d12;
                 color: #dbe5f1; font: 17px/1.7 Georgia, -apple-system, serif; }
          h1 { font: 600 22px/1.35 -apple-system, system-ui, sans-serif; margin: 0 0 6px; }
          .from { font: 11px/1.4 ui-monospace, monospace; color: #6f8093; margin-bottom: 22px;
                  word-break: break-all; }
          img, video, iframe { max-width: 100%; height: auto; }
          pre, code { font: 13px/1.5 ui-monospace, monospace; background: #11171f; padding: 2px 4px;
                      border-radius: 4px; }
          a { color: #4fe3c1; }
        </style></head><body>
        <h1>\(title)</h1>
        <div class="from">\(url)</div>
        \(html)
        </body></html>
        """
    }
}

// MARK: - Engine

enum WardenEngine {

    /// The rule list is compiled once per process and reused by every tab that
    /// still has blocking on; `WKContentRuleListStore` caches it by identifier
    /// between launches as well.
    private static var cachedRules: WKContentRuleList?
    private static var compiling = false
    private static var waiting: [() -> Void] = []

    /**
     Install WARDEN's scripts for one tab.

     Per tab rather than per app because the cookie lock is built from the
     allowlist, which is host-dependent. The cosmetic pass and the rule list are
     attached by `WardenAdBlocker.install` when the host is still filtered.
     */
    static func installScripts(
        on controller: WKUserContentController,
        cookiesAllowed: Bool
    ) {
        controller.addUserScript(
            WKUserScript(
                source: WardenScripts.fingerprint,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
        )

        if !cookiesAllowed {
            controller.addUserScript(
                WKUserScript(
                    source: WardenScripts.cookieLock(allowed: WardenPolicy.shared.allowedCookieHosts()),
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                )
            )
        }
    }

    /**
     Compile the rule list, then run `apply`.

     The manifest is per tab because `WKUserContentController` carries the rules
     for one web view; compiling is shared, attaching is not.
     */
    static func rules(_ apply: @escaping (WKContentRuleList?) -> Void) {
        if let cached = cachedRules {
            apply(cached)
            return
        }
        waiting.append({ apply(cachedRules) })
        if compiling { return }
        compiling = true

        guard let json = WardenAdBlocker.rulesJSON(), let store = WKContentRuleListStore.default() else {
            finish(nil)
            return
        }

        store.compileContentRuleList(forIdentifier: "warden-baseline", encodedContentRuleList: json) { list, _ in
            DispatchQueue.main.async {
                finish(list)
            }
        }
    }

    private static func finish(_ list: WKContentRuleList?) {
        cachedRules = list
        compiling = false
        let pending = waiting
        waiting = []
        for callback in pending { callback() }
    }

    /**
     Clear cookies the current policy does not allow.

     The store is already non-persistent, so this is the second half of the same
     promise the desktop makes: a page nobody allowed is not carrying a session
     into the next page it opens, even inside this run.
     */
    static func purgeCookies(store: WKWebsiteDataStore, keeping allowed: [String], completion: (() -> Void)? = nil) {
        store.httpCookieStore.getAllCookies { cookies in
            let denied = cookies.filter { cookie in
                let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
                return !allowed.contains { entry in
                    domain == entry || domain.hasSuffix("." + entry)
                }
            }
            guard !denied.isEmpty else {
                DispatchQueue.main.async { completion?() }
                return
            }
            let group = DispatchGroup()
            for cookie in denied {
                group.enter()
                store.httpCookieStore.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main) { completion?() }
        }
    }

    /// `http://host` becomes `https://host` before it leaves the app.
    static func upgraded(_ url: URL) -> URL? {
        guard url.scheme?.lowercased() == "http", var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        parts.scheme = "https"
        return parts.url
    }
}
