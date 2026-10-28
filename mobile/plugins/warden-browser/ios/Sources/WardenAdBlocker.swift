import Foundation
import WebKit

/**
 Ad and tracker blocking for the in-app browser.

 The desktop build blocks at the network layer, where a request can be refused
 before it is sent. `WKWebView` has no such hook: it offers content rule lists,
 which are compiled by the same engine and applied before the page's own scripts
 run. This file builds one from the same host and path rules the desktop product
 ships, and adds the second half of the promise — the cosmetic pass that removes
 the slot a blocked ad leaves behind, so the page closes up instead of showing a
 hole with a label where the ad used to be.

 Blocking alone is not enough on a page like a news front page: the iframe is
 refused, but its empty container keeps its reserved height, which reads as a
 broken page. `cosmeticScript` hides the known containers, collapses the wrappers
 that held only the ad, and re-runs as the page changes.
 */
enum WardenAdBlocker {

    /// Ad networks, named by the desktop's `builtin-lists.ts`.
    static let adHosts: [String] = [
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "adservice.google.com",
        "pagead2.googlesyndication.com",
        "partner.googleadservices.com",
        "amazon-adsystem.com",
        "adnxs.com",
        "adsrvr.org",
        "rubiconproject.com",
        "pubmatic.com",
        "criteo.com",
        "criteo.net",
        "taboola.com",
        "outbrain.com",
        "revcontent.com",
        "mgid.com",
        "zedo.com",
        "openx.net",
        "appnexus.com",
        "casalemedia.com",
        "contextweb.com",
        "sharethrough.com",
        "smartadserver.com",
        "teads.tv",
        "spotxchange.com",
        "tremorhub.com",
        "yieldmo.com",
        "indexww.com",
        "sovrn.com",
        "gumgum.com",
        "adform.net",
        "advertising.com",
        "adroll.com",
        "bidswitch.net",
        "bluekai.com",
        "demdex.net",
        "everesttech.net",
        "krxd.net",
        "mathtag.com",
        "moatads.com",
        "serving-sys.com",
        "tidaltv.com",
        "tribalfusion.com",
        "turn.com",
        "yieldlab.net",
        "zemanta.com",
        "adhigh.net",
        "adition.com",
        "adotmob.com",
        "adumbrella.com",
        "bat.bing.com",
        "ads.linkedin.com",
        "ads.pinterest.com",
        "ads.reddit.com",
        "ads.twitter.com",
        "adserver.yahoo.com",
        "ads.yahoo.com",
        "media.fastclick.net",
        "securepubads.g.doubleclick.net",
        "static.criteo.net",
        "ib.adnxs.com",
        "sync.outbrain.com",
        "widgets.outbrain.com",
        "cdn.taboola.com",
        "trc.taboola.com",
        // Yahoo's own ad delivery, which is what a front page loads first.
        "gemini.yahoo.com",
        "e.yahoo.com",
        "advertising.yahoo.com",
        "analytics.yahoo.com",
        "geo.yahoo.com",
        "uds.yahoo.com",
        "nads.io"
    ]

    /// Analytics, pixels and third-party widgets.
    static let trackerHosts: [String] = [
        "google-analytics.com",
        "analytics.google.com",
        "googletagmanager.com",
        "googletagservices.com",
        "ssl.google-analytics.com",
        "stats.g.doubleclick.net",
        "segment.io",
        "segment.com",
        "api.segment.io",
        "cdn.segment.com",
        "mixpanel.com",
        "api.mixpanel.com",
        "amplitude.com",
        "api.amplitude.com",
        "heap.io",
        "heapanalytics.com",
        "fullstory.com",
        "hotjar.com",
        "static.hotjar.com",
        "mouseflow.com",
        "clarity.ms",
        "newrelic.com",
        "nr-data.net",
        "bam.nr-data.net",
        "sentry.io",
        "bugsnag.com",
        "rollbar.com",
        "logrocket.com",
        "cdn.lr-ingest.io",
        "optimizely.com",
        "cdn.optimizely.com",
        "vwo.com",
        "visualwebsiteoptimizer.com",
        "quantserve.com",
        "quantcount.com",
        "scorecardresearch.com",
        "sb.scorecardresearch.com",
        "comscore.com",
        "chartbeat.com",
        "chartbeat.net",
        "parsely.com",
        "pixel.parsely.com",
        "crazyegg.com",
        "clicktale.net",
        "inspectlet.com",
        "luckyorange.com",
        "smartlook.com",
        "statcounter.com",
        "histats.com",
        "matomo.cloud",
        "piwik.pro",
        "plausible.io",
        "plausible.blue",
        "umami.is",
        "facebook.net",
        "connect.facebook.net",
        "pixel.facebook.com",
        "graph.facebook.com",
        "tr.snapchat.com",
        "sc-static.net",
        "ads.tiktok.com",
        "analytics.tiktok.com",
        "business-api.tiktok.com",
        "pinimg.com/ct",
        "ct.pinterest.com",
        "analytics.twitter.com",
        "static.ads-twitter.com",
        "t.co/i/adsct",
        "px.ads.linkedin.com",
        "snap.licdn.com",
        "c.clarity.ms",
        "branch.io",
        "app.adjust.com",
        "appsflyer.com",
        "kochava.com",
        "onesignal.com",
        "cdn.onesignal.com",
        "pushengage.com",
        "pushwoosh.com",
        "sendpulse.com",
        "tawk.to",
        "embed.tawk.to",
        "intercom.io",
        "widget.intercom.io",
        "drift.com",
        "js.driftt.com",
        "crisp.chat",
        "client.crisp.chat",
        "zendesk.com/embeddable",
        "zdassets.com",
        "livechatinc.com",
        "olark.com",
        "freshchat.com",
        "wchat.freshchat.com",
        "usercentrics.eu",
        "cdn.cookielaw.org",
        "onetrust.com",
        "cookiebot.com",
        "consentmanager.net",
        "quantcast.mgr.consensu.org",
        "fundingchoicesmessages.google.com",
        "privacymanager.io",
        "sourcepoint.com",
        "cdn.privacy-mgmt.com",
        "adsafeprotected.com",
        "moatpixel.com",
        "doubleverify.com",
        "iasds01.com",
        "adlightning.com",
        "confiant-integrations.net",
        "clarium.io",
        "btlr.sharethrough.com",
        "evs.sgmt.app",
        "id5-sync.com",
        "liadm.com",
        "rlcdn.com",
        "tapad.com",
        "crwdcntrl.net",
        "agkn.com",
        "adsymptotic.com",
        "bing.com/bat.js"
    ]

    /// Path fragments that are almost always an ad or tracking endpoint.
    static let pathFragments: [String] = [
        "/pagead/",
        "/adsbygoogle",
        "/adserver/",
        "/advert/",
        "/banner_ad",
        "/prebid",
        "/gpt.js",
        "/gtag/js",
        "/analytics.js",
        "/ga.js",
        "/fbevents.js",
        "/facebook-pixel",
        "/tracking/pixel",
        "/telemetry/",
        "/collect?v=",
        "/gtm.js",
        "/cdn-cgi/rum",
        "/cdn-cgi/challenge-platform/scripts/jsd/main.js"
    ]

    /**
     The containers an ad occupies, by the names the networks give them.

     Deliberately narrow: a broad `[class*="ad"]` would take the navigation and
     the article body with it, which is a worse page than one with an ad.
     */
    static let cosmeticSelectors: [String] = [
        ".adsbygoogle",
        "ins.adsbygoogle",
        "[id^=\"google_ads\"]",
        "[id^=\"div-gpt-ad\"]",
        "[id^=\"gpt-passback\"]",
        "[id^=\"ad-slot\"]",
        "[id^=\"ad_slot\"]",
        "[class^=\"ad-slot\"]",
        "[class*=\" ad-slot\"]",
        "[data-ad]",
        "[data-ad-slot]",
        "[data-ad-unit]",
        "[data-google-query-id]",
        "[id^=\"taboola\"]",
        "[class^=\"trc_\"]",
        "[id^=\"outbrain\"]",
        ".OUTBRAIN",
        "[id*=\"yahoo_ads\"]",
        "[id^=\"ybar-ad\"]",
        ".ybar-ad",
        ".ad-wrap",
        ".ad-container",
        "iframe[src*=\"doubleclick.net\"]",
        "iframe[src*=\"googlesyndication\"]",
        "iframe[src*=\"adserver.yahoo\"]",
        "iframe[src*=\"ads.yahoo\"]",
        "iframe[src*=\"amazon-adsystem\"]",
        "iframe[src*=\"taboola.com\"]",
        "iframe[src*=\"outbrain.com\"]"
    ]

    /// Hosts to block, split from the path rules because the two use different
    /// triggers in a content rule list.
    static var blockedHosts: [String] {
        (adHosts + trackerHosts).filter { !$0.contains("/") }
    }

    static var blockedPaths: [String] {
        (adHosts + trackerHosts).filter { $0.contains("/") } + pathFragments
    }

    /// Every host name the page script is given, so it can find an iframe that
    /// is still in the document after its request was refused.
    static var blockedHostNames: [String] { blockedHosts }

    // MARK: - Rules

    /// Escape the characters a WebKit `url-filter` would read as regex.
    private static func escaped(_ value: String) -> String {
        var out = ""
        for character in value {
            if "\\.+*?()[]{}|^$".contains(character) {
                out.append("\\")
            }
            out.append(character)
        }
        return out
    }

    /**
     The content rule list, as JSON.

     Hosts are grouped so the list stays a handful of rules instead of one per
     host; WebKit compiles the whole list, and a list that big takes longer to
     compile than a page takes to load.
     */
    static func rulesJSON() -> String? {
        var rules: [[String: Any]] = []

        let hosts = blockedHosts
        var index = 0
        while index < hosts.count {
            let chunk = Array(hosts[index..<min(index + 60, hosts.count)])
            index += 60
            rules.append([
                "trigger": [
                    "url-filter": ".*",
                    "if-domain": chunk.map { "*" + $0 },
                    "resource-type": [
                        "document", "image", "style-sheet", "script", "font",
                        "media", "raw", "svg-document", "popup"
                    ]
                ] as [String: Any],
                "action": ["type": "block"] as [String: Any]
            ])
        }

        for fragment in blockedPaths {
            rules.append([
                "trigger": ["url-filter": "(?i)" + escaped(fragment)] as [String: Any],
                "action": ["type": "block"] as [String: Any]
            ])
        }

        rules.append([
            "trigger": ["url-filter": ".*"] as [String: Any],
            "action": [
                "type": "css-display-none",
                "selector": cosmeticSelectors.joined(separator: ", ")
            ] as [String: Any]
        ])

        guard let data = try? JSONSerialization.data(withJSONObject: rules, options: []),
              let json = String(data: data, encoding: .utf8) else {
            return nil
        }
        return json
    }

    // MARK: - Cosmetic pass

    /**
     Runs in the page, so it is written as plain JavaScript.

     Two jobs: hide the containers the rule list cannot reach (because they are
     not the request itself), and close up the space they leave. A wrapper is
     only collapsed when nothing else in it is visible and it has no text of its
     own, so an article that happens to sit inside the same section keeps its
     body.
     */
    static var cosmeticScript: String {
        let hosts = blockedHostNames.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
        let selectors = cosmeticSelectors.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
        return """
        (function () {
          var blocked = [\(hosts.joined(separator: ", "))];
          var selectors = [\(selectors.joined(separator: ", "))];
          if (!document || !document.documentElement) return;

          function hostBlocked(url) {
            try {
              var host = new URL(url, location.href).hostname.toLowerCase();
              for (var i = 0; i < blocked.length; i += 1) {
                var entry = blocked[i];
                if (host === entry || host.slice(-entry.length - 1) === "." + entry) return true;
              }
            } catch (error) { /* not a URL we can judge */ }
            return false;
          }

          function visible(element) {
            if (!element || !element.getBoundingClientRect) return false;
            if (element.getBoundingClientRect().height <= 0) return false;
            var style = window.getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden";
          }

          function hide(element) {
            if (!element || element === document.body || element === document.documentElement) return;
            element.style.setProperty("display", "none", "important");
          }

          // The ad's wrapper usually holds the ad and nothing else; the page
          // keeps its height until that wrapper goes too.
          function collapse(element) {
            hide(element);
            var parent = element.parentElement;
            var depth = 0;
            while (parent && parent !== document.body && depth < 3) {
              if ((parent.textContent || "").trim()) break;
              var holdsSomething = false;
              for (var i = 0; i < parent.children.length; i += 1) {
                var child = parent.children[i];
                if (child === element) continue;
                if (visible(child)) { holdsSomething = true; break; }
              }
              if (holdsSomething) break;
              hide(parent);
              parent = parent.parentElement;
              depth += 1;
            }
          }

          function sweep() {
            for (var i = 0; i < selectors.length; i += 1) {
              var found;
              try { found = document.querySelectorAll(selectors[i]); } catch (error) { continue; }
              for (var j = 0; j < found.length; j += 1) collapse(found[j]);
            }
            var frames = document.querySelectorAll("iframe");
            for (var k = 0; k < frames.length; k += 1) {
              var frame = frames[k];
              if (frame.getAttribute("src") && hostBlocked(frame.src)) collapse(frame);
            }
          }

          sweep();
          // A front page builds its slots after load and swaps them on scroll,
          // so a single pass leaves the second ad in place.
          var pending = 0;
          function schedule() {
            if (pending) return;
            pending = window.setTimeout(function () {
              pending = 0;
              sweep();
            }, 120);
          }
          if (window.MutationObserver) {
            new MutationObserver(schedule).observe(document.documentElement, {
              childList: true,
              subtree: true
            });
          }
        })();
        """
    }

    /// Compile the rules and attach them, then let the caller load the page.
    ///
    /// Loading first and adding the list afterwards leaves the first page — the
    /// one the operator opened WARDEN to read — unfiltered.
    static func install(on controller: WKUserContentController, completion: @escaping () -> Void) {
        controller.addUserScript(
            WKUserScript(source: cosmeticScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )

        guard let json = rulesJSON(), let store = WKContentRuleListStore.default() else {
            DispatchQueue.main.async { completion() }
            return
        }

        store.compileContentRuleList(forIdentifier: "warden-baseline", encodedContentRuleList: json) { list, _ in
            DispatchQueue.main.async {
                if let list = list { controller.add(list) }
                completion()
            }
        }
    }
}
