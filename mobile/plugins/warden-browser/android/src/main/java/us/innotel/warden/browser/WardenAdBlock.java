package us.innotel.warden.browser;

import android.net.Uri;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Ad and tracker blocking for the in-app browser.
 *
 * <p>The desktop build refuses a request before it is sent. A {@code WebView} has
 * no such hook, but it does have
 * {@link android.webkit.WebViewClient#shouldInterceptRequest}, which runs on a
 * background thread before the request leaves the app — the same decision at the
 * same point, one engine down. Blocking alone is not enough on a news front
 * page: the iframe is refused and its empty container keeps its reserved height,
 * so {@link #cosmeticScript()} removes the slot and closes the page up.
 *
 * <p>The host list is the same one the iOS surface ships
 * ({@code WardenAdBlocker.swift}), which is the same set the desktop's
 * {@code builtin-lists.ts} starts from. A parity test parses both files, so the
 * platforms cannot drift apart quietly.
 */
public final class WardenAdBlock {

    private WardenAdBlock() {}

    /** Splits a block of one-entry-per-line text, ignoring blank and comment lines. */
    private static List<String> words(String block) {
        List<String> out = new ArrayList<>();
        for (String line : block.split("\n")) {
            String value = line.trim();
            if (!value.isEmpty() && !value.startsWith("//")) {
                out.add(value);
            }
        }
        return out;
    }

    /** Ad networks. */
    private static final List<String> AD_HOSTS = words(
        "doubleclick.net\n"
            + "googlesyndication.com\n"
            + "googleadservices.com\n"
            + "adservice.google.com\n"
            + "pagead2.googlesyndication.com\n"
            + "partner.googleadservices.com\n"
            + "amazon-adsystem.com\n"
            + "adnxs.com\n"
            + "adsrvr.org\n"
            + "rubiconproject.com\n"
            + "pubmatic.com\n"
            + "criteo.com\n"
            + "criteo.net\n"
            + "taboola.com\n"
            + "outbrain.com\n"
            + "revcontent.com\n"
            + "mgid.com\n"
            + "zedo.com\n"
            + "openx.net\n"
            + "appnexus.com\n"
            + "casalemedia.com\n"
            + "contextweb.com\n"
            + "sharethrough.com\n"
            + "smartadserver.com\n"
            + "teads.tv\n"
            + "spotxchange.com\n"
            + "tremorhub.com\n"
            + "yieldmo.com\n"
            + "indexww.com\n"
            + "sovrn.com\n"
            + "gumgum.com\n"
            + "adform.net\n"
            + "advertising.com\n"
            + "adroll.com\n"
            + "bidswitch.net\n"
            + "bluekai.com\n"
            + "demdex.net\n"
            + "everesttech.net\n"
            + "krxd.net\n"
            + "mathtag.com\n"
            + "moatads.com\n"
            + "serving-sys.com\n"
            + "tidaltv.com\n"
            + "tribalfusion.com\n"
            + "turn.com\n"
            + "yieldlab.net\n"
            + "zemanta.com\n"
            + "adhigh.net\n"
            + "adition.com\n"
            + "adotmob.com\n"
            + "adumbrella.com\n"
            + "bat.bing.com\n"
            + "ads.linkedin.com\n"
            + "ads.pinterest.com\n"
            + "ads.reddit.com\n"
            + "ads.twitter.com\n"
            + "adserver.yahoo.com\n"
            + "ads.yahoo.com\n"
            + "media.fastclick.net\n"
            + "securepubads.g.doubleclick.net\n"
            + "static.criteo.net\n"
            + "ib.adnxs.com\n"
            + "sync.outbrain.com\n"
            + "widgets.outbrain.com\n"
            + "cdn.taboola.com\n"
            + "trc.taboola.com\n"
            // Yahoo's own ad delivery, which is what a front page loads first.
            + "gemini.yahoo.com\n"
            + "e.yahoo.com\n"
            + "advertising.yahoo.com\n"
            + "analytics.yahoo.com\n"
            + "geo.yahoo.com\n"
            + "uds.yahoo.com\n"
            + "nads.io");

    /** Analytics, pixels and third-party widgets. */
    private static final List<String> TRACKER_HOSTS = words(
        "google-analytics.com\n"
            + "analytics.google.com\n"
            + "googletagmanager.com\n"
            + "googletagservices.com\n"
            + "ssl.google-analytics.com\n"
            + "stats.g.doubleclick.net\n"
            + "segment.io\n"
            + "segment.com\n"
            + "api.segment.io\n"
            + "cdn.segment.com\n"
            + "mixpanel.com\n"
            + "api.mixpanel.com\n"
            + "amplitude.com\n"
            + "api.amplitude.com\n"
            + "heap.io\n"
            + "heapanalytics.com\n"
            + "fullstory.com\n"
            + "hotjar.com\n"
            + "static.hotjar.com\n"
            + "mouseflow.com\n"
            + "clarity.ms\n"
            + "newrelic.com\n"
            + "nr-data.net\n"
            + "bam.nr-data.net\n"
            + "sentry.io\n"
            + "bugsnag.com\n"
            + "rollbar.com\n"
            + "logrocket.com\n"
            + "cdn.lr-ingest.io\n"
            + "optimizely.com\n"
            + "cdn.optimizely.com\n"
            + "vwo.com\n"
            + "visualwebsiteoptimizer.com\n"
            + "quantserve.com\n"
            + "quantcount.com\n"
            + "scorecardresearch.com\n"
            + "sb.scorecardresearch.com\n"
            + "comscore.com\n"
            + "chartbeat.com\n"
            + "chartbeat.net\n"
            + "parsely.com\n"
            + "pixel.parsely.com\n"
            + "crazyegg.com\n"
            + "clicktale.net\n"
            + "inspectlet.com\n"
            + "luckyorange.com\n"
            + "smartlook.com\n"
            + "statcounter.com\n"
            + "histats.com\n"
            + "matomo.cloud\n"
            + "piwik.pro\n"
            + "plausible.io\n"
            + "plausible.blue\n"
            + "umami.is\n"
            + "facebook.net\n"
            + "connect.facebook.net\n"
            + "pixel.facebook.com\n"
            + "graph.facebook.com\n"
            + "tr.snapchat.com\n"
            + "sc-static.net\n"
            + "ads.tiktok.com\n"
            + "analytics.tiktok.com\n"
            + "business-api.tiktok.com\n"
            + "pinimg.com/ct\n"
            + "ct.pinterest.com\n"
            + "analytics.twitter.com\n"
            + "static.ads-twitter.com\n"
            + "t.co/i/adsct\n"
            + "px.ads.linkedin.com\n"
            + "snap.licdn.com\n"
            + "c.clarity.ms\n"
            + "branch.io\n"
            + "app.adjust.com\n"
            + "appsflyer.com\n"
            + "kochava.com\n"
            + "onesignal.com\n"
            + "cdn.onesignal.com\n"
            + "pushengage.com\n"
            + "pushwoosh.com\n"
            + "sendpulse.com\n"
            + "tawk.to\n"
            + "embed.tawk.to\n"
            + "intercom.io\n"
            + "widget.intercom.io\n"
            + "drift.com\n"
            + "js.driftt.com\n"
            + "crisp.chat\n"
            + "client.crisp.chat\n"
            + "zendesk.com/embeddable\n"
            + "zdassets.com\n"
            + "livechatinc.com\n"
            + "olark.com\n"
            + "freshchat.com\n"
            + "wchat.freshchat.com\n"
            + "usercentrics.eu\n"
            + "cdn.cookielaw.org\n"
            + "onetrust.com\n"
            + "cookiebot.com\n"
            + "consentmanager.net\n"
            + "quantcast.mgr.consensu.org\n"
            + "fundingchoicesmessages.google.com\n"
            + "privacymanager.io\n"
            + "sourcepoint.com\n"
            + "cdn.privacy-mgmt.com\n"
            + "adsafeprotected.com\n"
            + "moatpixel.com\n"
            + "doubleverify.com\n"
            + "iasds01.com\n"
            + "adlightning.com\n"
            + "confiant-integrations.net\n"
            + "clarium.io\n"
            + "btlr.sharethrough.com\n"
            + "evs.sgmt.app\n"
            + "id5-sync.com\n"
            + "liadm.com\n"
            + "rlcdn.com\n"
            + "tapad.com\n"
            + "crwdcntrl.net\n"
            + "agkn.com\n"
            + "adsymptotic.com\n"
            + "bing.com/bat.js");

    /** Path fragments that are almost always an ad or tracking endpoint. */
    private static final List<String> PATH_FRAGMENTS = words(
        "/pagead/\n"
            + "/adsbygoogle\n"
            + "/adserver/\n"
            + "/advert/\n"
            + "/banner_ad\n"
            + "/prebid\n"
            + "/gpt.js\n"
            + "/gtag/js\n"
            + "/analytics.js\n"
            + "/ga.js\n"
            + "/fbevents.js\n"
            + "/facebook-pixel\n"
            + "/tracking/pixel\n"
            + "/telemetry/\n"
            + "/collect?v=\n"
            + "/gtm.js\n"
            + "/cdn-cgi/rum\n"
            + "/cdn-cgi/challenge-platform/scripts/jsd/main.js");

    /**
     * The containers an ad occupies, by the names the networks give them.
     *
     * <p>Deliberately narrow: {@code [class*="ad"]} would take the navigation and
     * the article body with it, which is a worse page than one with an ad in it.
     */
    private static final List<String> COSMETIC_SELECTORS = Arrays.asList(
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
        "iframe[src*=\"outbrain.com\"]");

    /** Hosts only — the paths below are matched separately. */
    public static List<String> blockedHosts() {
        List<String> hosts = new ArrayList<>();
        for (String entry : all()) {
            if (!entry.contains("/")) {
                hosts.add(entry);
            }
        }
        return hosts;
    }

    private static List<String> all() {
        List<String> out = new ArrayList<>(AD_HOSTS);
        out.addAll(TRACKER_HOSTS);
        return out;
    }

    private static List<String> blockedPaths() {
        List<String> paths = new ArrayList<>();
        for (String entry : all()) {
            if (entry.contains("/")) {
                paths.add(entry);
            }
        }
        paths.addAll(PATH_FRAGMENTS);
        return paths;
    }

    /**
     * Whether a request should be refused.
     *
     * <p>Suffix matching, so {@code ads.yahoo.com.evil.example} is not treated as
     * Yahoo and {@code geo.yahoo.com} is: a blocked name is blocked for its
     * subdomains too, which is why the list carries the entry itself rather than
     * a wildcard.
     */
    public static boolean isBlocked(String url) {
        if (url == null) {
            return false;
        }
        Uri parsed;
        try {
            parsed = Uri.parse(url);
        } catch (Exception error) {
            return false;
        }
        String host = parsed.getHost();
        if (host == null) {
            return false;
        }
        host = host.toLowerCase();
        for (String entry : blockedHosts()) {
            if (host.equals(entry) || host.endsWith("." + entry)) {
                return true;
            }
        }
        String path = (parsed.getPath() == null ? "" : parsed.getPath());
        if (parsed.getQuery() != null) {
            path = path + "?" + parsed.getQuery();
        }
        path = path.toLowerCase();
        for (String fragment : blockedPaths()) {
            if (path.contains(fragment.toLowerCase())) {
                return true;
            }
        }
        return false;
    }

    private static String quoted(List<String> values) {
        StringBuilder out = new StringBuilder();
        for (String value : values) {
            if (out.length() > 0) {
                out.append(", ");
            }
            out.append('"').append(value.replace("\"", "\\\"")).append('"');
        }
        return out.toString();
    }

    /**
     * Runs in the page, so it is written as plain JavaScript.
     *
     * <p>Two jobs: hide the containers the request filter cannot reach (they are
     * not the request itself), and close up the space they leave. A wrapper is
     * only collapsed when nothing else in it is visible and it holds no text of
     * its own, so an article that happens to share a section keeps its body.
     */
    public static String cosmeticScript() {
        String hosts = quoted(blockedHosts());
        String selectors = quoted(COSMETIC_SELECTORS);
        return "(function () {\n"
            + "  var blocked = [" + hosts + "];\n"
            + "  var selectors = [" + selectors + "];\n"
            + "  if (!document || !document.documentElement) return;\n"
            + "\n"
            + "  function hostBlocked(url) {\n"
            + "    try {\n"
            + "      var host = new URL(url, location.href).hostname.toLowerCase();\n"
            + "      for (var i = 0; i < blocked.length; i += 1) {\n"
            + "        var entry = blocked[i];\n"
            + "        if (host === entry || host.slice(-entry.length - 1) === \".\" + entry) return true;\n"
            + "      }\n"
            + "    } catch (error) { /* not a URL we can judge */ }\n"
            + "    return false;\n"
            + "  }\n"
            + "\n"
            + "  function visible(element) {\n"
            + "    if (!element || !element.getBoundingClientRect) return false;\n"
            + "    if (element.getBoundingClientRect().height <= 0) return false;\n"
            + "    var style = window.getComputedStyle(element);\n"
            + "    return style.display !== \"none\" && style.visibility !== \"hidden\";\n"
            + "  }\n"
            + "\n"
            + "  function hide(element) {\n"
            + "    if (!element || element === document.body || element === document.documentElement) return;\n"
            + "    element.style.setProperty(\"display\", \"none\", \"important\");\n"
            + "  }\n"
            + "\n"
            + "  function collapse(element) {\n"
            + "    hide(element);\n"
            + "    var parent = element.parentElement;\n"
            + "    var depth = 0;\n"
            + "    while (parent && parent !== document.body && depth < 3) {\n"
            + "      if ((parent.textContent || \"\").trim()) break;\n"
            + "      var holdsSomething = false;\n"
            + "      for (var i = 0; i < parent.children.length; i += 1) {\n"
            + "        var child = parent.children[i];\n"
            + "        if (child === element) continue;\n"
            + "        if (visible(child)) { holdsSomething = true; break; }\n"
            + "      }\n"
            + "      if (holdsSomething) break;\n"
            + "      hide(parent);\n"
            + "      parent = parent.parentElement;\n"
            + "      depth += 1;\n"
            + "    }\n"
            + "  }\n"
            + "\n"
            + "  function sweep() {\n"
            + "    for (var i = 0; i < selectors.length; i += 1) {\n"
            + "      var found;\n"
            + "      try { found = document.querySelectorAll(selectors[i]); } catch (error) { continue; }\n"
            + "      for (var j = 0; j < found.length; j += 1) collapse(found[j]);\n"
            + "    }\n"
            + "    var frames = document.querySelectorAll(\"iframe\");\n"
            + "    for (var k = 0; k < frames.length; k += 1) {\n"
            + "      var frame = frames[k];\n"
            + "      if (frame.getAttribute(\"src\") && hostBlocked(frame.src)) collapse(frame);\n"
            + "    }\n"
            + "  }\n"
            + "\n"
            + "  sweep();\n"
            + "  // A front page builds its slots after load and swaps them on scroll,\n"
            + "  // so one pass leaves the second ad in place.\n"
            + "  var pending = 0;\n"
            + "  function schedule() {\n"
            + "    if (pending) return;\n"
            + "    pending = window.setTimeout(function () { pending = 0; sweep(); }, 120);\n"
            + "  }\n"
            + "  if (window.MutationObserver) {\n"
            + "    new MutationObserver(schedule).observe(document.documentElement, {\n"
            + "      childList: true,\n"
            + "      subtree: true\n"
            + "    });\n"
            + "  }\n"
            + "})();";
    }
}
