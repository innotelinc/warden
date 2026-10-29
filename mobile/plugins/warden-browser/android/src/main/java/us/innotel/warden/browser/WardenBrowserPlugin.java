package us.innotel.warden.browser;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.JsonReader;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.StringReader;
import java.lang.ref.WeakReference;
import java.util.Locale;

/**
 * The bridge to WARDEN's own browser surface.
 *
 * <p>{@code open} starts {@link WardenBrowserActivity} — our WebView, our chrome —
 * and resolves as soon as it is on screen, so the shell knows the page opened
 * inside WARDEN rather than in another app. Where the surface goes afterwards
 * comes back as a {@code navigated} event; {@code closed} fires with the
 * session's teardown.
 *
 * <p>{@code scry} is the operator surface: the shell passes the capture script,
 * the surface loads the page, evaluates it and hands the JSON back through
 * {@link #deliverCapture}, which resolves the waiting call. {@code openService}
 * and {@code clearServiceData} reach {@link WardenServicesActivity}, which runs
 * in its own process so its session survives the private browser's teardown.
 *
 * <p>The JS side ({@code mobile/src/warden-browser.ts}) falls back to the system
 * browser if this plugin is absent, so an older build keeps working.
 */
@CapacitorPlugin(name = "WardenBrowser")
public class WardenBrowserPlugin extends Plugin {

    /** A capture has loaded a page; a slow one must not hang the shell forever. */
    private static final long CAPTURE_TIMEOUT_MS = 30_000;

    /**
     * The activity needs a way back to the bridge to report events, and a static
     * held weakly is the smallest version of that: it cannot outlive the plugin,
     * so a recreated bridge does not deliver to a dead one.
     */
    private static WeakReference<WardenBrowserPlugin> current;

    private PluginCall pendingCapture;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private static WardenBrowserPlugin live() {
        return current == null ? null : current.get();
    }

    static void emitNavigated(String url, String title) {
        WardenBrowserPlugin plugin = live();
        if (plugin == null) {
            return;
        }
        plugin.notifyListeners("navigated", new JSObject().put("url", url).put("title", title));
    }

    static void emitClosed() {
        WardenBrowserPlugin plugin = live();
        if (plugin == null) {
            return;
        }
        plugin.notifyListeners("closed", new JSObject());
    }

    /**
     * The capture coming back from the surface.
     *
     * <p>{@code evaluateJavascript} hands a string result back JSON-quoted, so the
     * value is unquoted once here and the shell parses plain JSON on both
     * platforms instead of each side guessing which shape it got.
     */
    static boolean deliverCapture(String value) {
        WardenBrowserPlugin plugin = live();
        if (plugin == null) {
            return false;
        }
        return plugin.resolveCapture(unquote(value));
    }

    @Override
    public void load() {
        current = new WeakReference<>(this);
    }

    @Override
    protected void handleOnDestroy() {
        if (pendingCapture != null) {
            pendingCapture.reject("The capture was interrupted.");
            pendingCapture = null;
        }
        current = null;
    }

    @PluginMethod
    public void open(PluginCall call) {
        Intent intent = intentFor(call, WardenBrowserActivity.class);
        if (intent == null) {
            call.reject("A http or https url is required");
            return;
        }
        if (!start(intent)) {
            call.reject("Could not open the browser");
            return;
        }
        call.resolve();
    }

    /**
     * Open a messaging or mail service in the persistent session.
     *
     * <p>Same surface, different process and data directory: the page looks
     * identical, and the only observable difference is that this one is still
     * signed in when it is opened again.
     */
    @PluginMethod
    public void openService(PluginCall call) {
        Intent intent = intentFor(call, WardenServicesActivity.class);
        if (intent == null) {
            call.reject("A http or https url is required");
            return;
        }
        intent.putExtra(WardenBrowserActivity.EXTRA_SESSION, WardenBrowserActivity.SESSION_SERVICE);
        if (!start(intent)) {
            call.reject("Could not open the service");
            return;
        }
        call.resolve();
    }

    /** Sign out of every service, by asking their process to wipe its store. */
    @PluginMethod
    public void clearServiceData(PluginCall call) {
        Intent intent = new Intent(getContext(), WardenServicesActivity.class);
        intent.putExtra(WardenServicesActivity.EXTRA_CLEAR, true);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (Exception error) {
            call.reject("Could not clear the service data: " + error.getMessage());
            return;
        }
        call.resolve();
    }

    /**
     * Capture the page at {@code url}: load it, read it, close it.
     *
     * <p>Always a fresh surface rather than the one already on screen. The shell
     * cannot know which page a stale surface is showing, and a report filed under
     * the wrong URL is worse than no report.
     */
    @PluginMethod
    public void scry(PluginCall call) {
        String script = call.getString("script");
        if (script == null || script.isEmpty()) {
            call.reject("A capture script is required");
            return;
        }
        Intent intent = intentFor(call, WardenBrowserActivity.class);
        if (intent == null) {
            call.reject("A http or https url is required");
            return;
        }
        if (pendingCapture != null) {
            pendingCapture.reject("Another capture is already running.");
            pendingCapture = null;
        }

        pendingCapture = call;
        call.setKeepAlive(true);
        intent.putExtra(WardenBrowserActivity.EXTRA_CAPTURE, true);
        intent.putExtra(WardenBrowserActivity.EXTRA_SCRIPT, script);

        if (!start(intent)) {
            pendingCapture = null;
            call.reject("Could not open the page to capture it");
            return;
        }

        handler.postDelayed(() -> {
            if (pendingCapture == call) {
                pendingCapture = null;
                call.reject("The capture timed out before the page finished loading.");
            }
        }, CAPTURE_TIMEOUT_MS);
    }

    private boolean resolveCapture(String json) {
        PluginCall call = pendingCapture;
        if (call == null) {
            return false;
        }
        pendingCapture = null;
        handler.removeCallbacksAndMessages(null);
        JSObject result = new JSObject();
        result.put("capture", json);
        call.resolve(result);
        return true;
    }

    /** Shared launch: validate the address, build the intent, keep it in-app. */
    private Intent intentFor(PluginCall call, Class<?> activity) {
        String raw = call.getString("url");
        if (raw == null) {
            return null;
        }
        raw = raw.trim();
        Uri uri = raw.isEmpty() ? null : Uri.parse(raw);
        String scheme = uri == null || uri.getScheme() == null
            ? ""
            : uri.getScheme().toLowerCase(Locale.ROOT);
        if (uri == null || (!scheme.equals("http") && !scheme.equals("https"))) {
            return null;
        }
        Intent intent = new Intent(getContext(), activity);
        intent.putExtra(WardenBrowserActivity.EXTRA_URL, raw);
        // The service session is chosen by which activity is started, not by an
        // option: a persistent session in this process would be wiped by the next
        // private close, so the only way to get one is the process that keeps it.
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    private boolean start(Intent intent) {
        try {
            getContext().startActivity(intent);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    /**
     * Turn the JSON-quoted string {@code evaluateJavascript} returns into the
     * string it quoted, escapes included.
     */
    private static String unquote(String value) {
        if (value == null) {
            return "{}";
        }
        String trimmed = value.trim();
        if (trimmed.length() >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            JsonReader reader = new JsonReader(new StringReader(trimmed));
            reader.setLenient(true);
            try {
                return reader.nextString();
            } catch (Exception malformed) {
                return trimmed.substring(1, trimmed.length() - 1);
            }
        }
        return trimmed;
    }
}
