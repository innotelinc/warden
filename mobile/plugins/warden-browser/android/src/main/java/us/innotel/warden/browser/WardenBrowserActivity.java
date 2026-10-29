package us.innotel.warden.browser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.ByteArrayInputStream;
import java.util.Locale;

/**
 * The browser surface: a real page engine with chrome of its own.
 *
 * <p>Android used to hand every address to Chrome Custom Tabs — another app's
 * screen, with another app's address bar — which made WARDEN a launcher rather
 * than a browser. This is WARDEN's own activity: a {@link WebView} for the page,
 * and the bar above it for back, forward, reload, the address, the host and a way
 * out. The same shape the iOS surface presents, so the product behaves the same
 * on both platforms.
 *
 * <p>Two kinds of session share this surface. A <b>private</b> one is the browser:
 * the cache is off and cookies, web storage, form data and cache are cleared in
 * {@link #onDestroy()}, so what a page leaves behind lives only while this screen
 * does. A <b>service</b> one is the operator's chat and mail: it keeps cookies and
 * cache, because a messaging app that asked you to log in again on every open
 * would not be usable. Services are launched in their own process with their own
 * WebView data directory ({@link WardenServicesActivity}), so the private
 * surface's wipe cannot reach them.
 *
 * <p>Scry captures come through here too: the shell passes a script, this surface
 * loads the page, evaluates it and hands the result back before closing.
 */
public class WardenBrowserActivity extends Activity {

    public static final String EXTRA_URL = "us.innotel.warden.BROWSER_URL";
    /** {@link #SESSION_PRIVATE} (default) or {@link #SESSION_SERVICE}. */
    public static final String EXTRA_SESSION = "us.innotel.warden.BROWSER_SESSION";
    /** Evaluate {@link #EXTRA_SCRIPT} once the page settles, then close. */
    public static final String EXTRA_CAPTURE = "us.innotel.warden.BROWSER_CAPTURE";
    public static final String EXTRA_SCRIPT = "us.innotel.warden.BROWSER_SCRIPT";

    public static final String SESSION_PRIVATE = "private";
    public static final String SESSION_SERVICE = "service";

    private static final String BACKGROUND = "#070a0d";
    private static final String SURFACE = "#101720";
    private static final String INK = "#dbe5f1";
    private static final String MUTED = "#7b8a9d";
    private static final String ACCENT = "#4fe3c1";

    private WebView webView;
    private EditText address;
    private TextView hostLabel;
    private TextView backButton;
    private TextView forwardButton;
    private ProgressBar progress;

    private WebResourceResponse blockedResponse;

    private boolean serviceSession;
    private boolean captureOnly;
    private String captureScript;
    private boolean captured;


    /**
     * Where a typed string goes — the same rule the shell and iOS use: a bare
     * host becomes https, an address stays as typed, anything else is a search.
     */
    public static String resolve(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) {
            return null;
        }
        String lower = value.toLowerCase(Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            return value;
        }
        if (value.matches("^[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}(:\\d+)?(/.*)?$")) {
            return "https://" + value;
        }
        if (value.matches("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?(/.*)?$")) {
            return "https://" + value;
        }
        return "https://duckduckgo.com/?q=" + Uri.encode(value);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        serviceSession = SESSION_SERVICE.equals(getIntent().getStringExtra(EXTRA_SESSION));
        captureOnly = getIntent().getBooleanExtra(EXTRA_CAPTURE, false);
        captureScript = getIntent().getStringExtra(EXTRA_SCRIPT);

        // Resolved before anything is built: a call that carries no address — a
        // store wipe in the service process, or a malformed launch — has nothing
        // to show and should not pay for chrome it will never display.
        String resolved = resolve(getIntent().getStringExtra(EXTRA_URL));
        if (resolved == null) {
            finish();
            return;
        }

        // targetSdk 35+ lays windows out edge to edge by default, which would put
        // the bar under the status bar. The chrome has to be reachable by thumb.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor(BACKGROUND));

        root.addView(buildChrome());
        root.addView(buildProgress());
        root.addView(buildWebView(), new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ));

        setContentView(root);

        load(resolved);
    }

    // MARK: - Chrome

    private View buildChrome() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor(SURFACE));
        bar.setPadding(dp(6), dp(8), dp(6), dp(8));

        bar.addView(button("\u2715", "Close", MUTED, () -> finish()));
        backButton = button("\u2039", "Back", INK, () -> {
            if (webView.canGoBack()) {
                webView.goBack();
            }
        });
        forwardButton = button("\u203A", "Forward", INK, () -> {
            if (webView.canGoForward()) {
                webView.goForward();
            }
        });
        bar.addView(backButton);
        bar.addView(forwardButton);

        address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setTextColor(Color.parseColor(INK));
        address.setHintTextColor(Color.parseColor(MUTED));
        address.setHint("Search or enter address");
        address.setTextSize(14f);
        address.setBackgroundColor(Color.parseColor("#1b2430"));
        address.setPadding(dp(12), dp(8), dp(12), dp(8));
        address.setSelectAllOnFocus(true);
        address.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId != EditorInfo.IME_ACTION_GO) {
                return false;
            }
            String target = resolve(view.getText().toString());
            if (target != null) {
                view.clearFocus();
                load(target);
            }
            return true;
        });
        LinearLayout.LayoutParams addressParams = new LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        );
        addressParams.setMarginStart(dp(6));
        addressParams.setMarginEnd(dp(6));
        bar.addView(address, addressParams);

        bar.addView(button("\u21BB", "Reload", INK, () -> {
            if (webView.getProgress() < 100) {
                webView.stopLoading();
            } else {
                webView.reload();
            }
        }));

        hostLabel = new TextView(this);
        hostLabel.setTextSize(10f);
        hostLabel.setTextColor(Color.parseColor(MUTED));
        hostLabel.setTypeface(Typeface.MONOSPACE);
        hostLabel.setMaxLines(1);

        column.addView(bar);
        LinearLayout.LayoutParams hostParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        );
        hostParams.leftMargin = dp(14);
        hostParams.topMargin = dp(2);
        hostParams.bottomMargin = dp(2);
        column.addView(hostLabel, hostParams);
        return column;
    }

    private View buildProgress() {
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgress(0);
        progress.setProgressTintList(ColorStateList.valueOf(Color.parseColor(ACCENT)));
        progress.setBackgroundTintList(ColorStateList.valueOf(Color.TRANSPARENT));
        return progress;
    }

    private TextView button(String label, String description, String color, final Runnable onClick) {
        TextView view = new TextView(this);
        view.setText(label);
        view.setTextSize(20f);
        view.setGravity(Gravity.CENTER);
        view.setTextColor(Color.parseColor(color));
        view.setContentDescription(description);
        view.setPadding(dp(10), dp(6), dp(10), dp(6));
        view.setClickable(true);
        view.setFocusable(true);
        view.setOnClickListener(v -> onClick.run());
        return view;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    // MARK: - The page

    @SuppressLint("SetJavaScriptEnabled")
    private WebView buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor(BACKGROUND));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // No disk cache in a private session: it is meant to die with this
        // screen. A service session is the opposite — a chat app re-downloading
        // its whole client on every open is not a browser, it is a wait.
        settings.setCacheMode(serviceSession ? WebSettings.LOAD_DEFAULT : WebSettings.LOAD_NO_CACHE);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(settings.getUserAgentString() + " WARDEN-Mobile");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        // Third-party cookies are what a tracker needs to follow a reader across
        // sites; the page's own session cookie stays, so a login still works.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptThirdPartyCookies(webView, false);
        cookies.setAcceptCookie(true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress > 0 && newProgress < 100 ? View.VISIBLE : View.GONE);
            }

            @Override
            public void onReceivedTitle(WebView view, String title) {
                emit(view.getUrl(), title);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            /** The network half of the promise: the request never leaves the app. */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request == null || request.getUrl() == null
                    ? null
                    : request.getUrl().toString();
                if (url == null || !WardenAdBlock.isBlocked(url)) {
                    return null;
                }
                if (blockedResponse == null) {
                    blockedResponse = new WebResourceResponse(
                        "text/plain", "utf-8", new ByteArrayInputStream(new byte[0])
                    );
                }
                return blockedResponse;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                syncChrome(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                syncChrome(url);
                // The cosmetic pass: the iframe is gone but its slot is not.
                view.evaluateJavascript(WardenAdBlock.cosmeticScript(), null);
                maybeCapture();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return route(request == null ? null : request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return route(url == null ? null : Uri.parse(url));
            }

            /** http and https stay here; everything else is the system's job. */
            private boolean route(Uri uri) {
                if (uri == null) {
                    return false;
                }
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
                if (scheme.equals("http") || scheme.equals("https")
                    || scheme.equals("about") || scheme.equals("data")) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException error) {
                    // No app for this scheme: leave the page where it is rather
                    // than replacing it with an error the reader cannot dismiss.
                }
                return true;
            }
        });

        return webView;
    }

    private void load(String url) {
        address.setText(url);
        address.clearFocus();
        webView.loadUrl(url);
    }

    /**
     * Scry, on the page this surface is showing.
     *
     * <p>Runs the shell's capture script and hands the result back through the
     * bridge. The short delay after {@code onPageFinished} is deliberate: a
     * capture taken the instant the document settles misses the requests that a
     * deferred script or a lazy image starts, and those are most of the third
     * parties the report exists to name.
     */
    private void maybeCapture() {
        if (!captureOnly || captured || captureScript == null || captureScript.isEmpty()) {
            return;
        }
        captured = true;
        webView.postDelayed(() -> {
            if (webView == null) {
                return;
            }
            webView.evaluateJavascript(captureScript, value -> {
                WardenBrowserPlugin.deliverCapture(value);
                finish();
            });
        }, 700);
    }

    private void syncChrome(String url) {
        String shown = url != null ? url : webView.getUrl();
        if (shown == null) {
            return;
        }
        address.setText(shown);
        String host = Uri.parse(shown).getHost();
        hostLabel.setText(host != null ? host : shown);
        backButton.setAlpha(webView.canGoBack() ? 1f : 0.3f);
        forwardButton.setAlpha(webView.canGoForward() ? 1f : 0.3f);
        emit(shown, webView.getTitle());
    }

    private void emit(String url, String title) {
        if (url == null) {
            return;
        }
        WardenBrowserPlugin.emitNavigated(url, title == null ? "" : title);
    }

    // MARK: - Lifecycle

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /**
     * The session ends here.
     *
     * <p>Cookies and web storage are the two places a page can leave something
     * that outlives the screen, so both are cleared before the engine is torn
     * down — otherwise "closing the browser clears the session" would be a claim
     * the app does not keep.
     */
    @Override
    protected void onDestroy() {
        if (webView != null) {
            try {
                closeEngine();
            } catch (Exception error) {
                // A teardown failure must not keep the screen alive.
            }
            webView = null;
        }
        WardenBrowserPlugin.emitClosed();
        super.onDestroy();
    }

    /**
     * The session ends here — for a private one.
     *
     * <p>Cookies and web storage are the two places a page can leave something
     * that outlives the screen, so both are cleared before the engine is torn
     * down. A service session skips all of it: that is what makes a chat app
     * still be logged in the next time it is opened, and it lives in its own
     * process with its own data directory, so this wipe cannot reach it.
     */
    private void closeEngine() {
        if (!serviceSession) {
            CookieManager cookies = CookieManager.getInstance();
            cookies.removeAllCookies(null);
            cookies.flush();
            WebStorage.getInstance().deleteAllData();
            webView.clearCache(true);
            webView.clearFormData();
        }
        webView.clearHistory();
        webView.stopLoading();
        webView.loadUrl("about:blank");
        webView.destroy();
    }
}
