package us.innotel.warden.browser;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
 * <p>The JS side ({@code mobile/src/warden-browser.ts}) falls back to the system
 * browser if this plugin is absent, so an older build keeps working.
 */
@CapacitorPlugin(name = "WardenBrowser")
public class WardenBrowserPlugin extends Plugin {

    /**
     * The activity needs a way back to the bridge to report events, and a static
     * held weakly is the smallest version of that: it cannot outlive the plugin,
     * so a recreated bridge does not deliver to a dead one.
     */
    private static WeakReference<WardenBrowserPlugin> current;

    static void emitNavigated(String url, String title) {
        WardenBrowserPlugin plugin = current == null ? null : current.get();
        if (plugin == null) {
            return;
        }
        plugin.notifyListeners("navigated", new JSObject().put("url", url).put("title", title));
    }

    static void emitClosed() {
        WardenBrowserPlugin plugin = current == null ? null : current.get();
        if (plugin == null) {
            return;
        }
        plugin.notifyListeners("closed", new JSObject());
    }

    @Override
    public void load() {
        current = new WeakReference<>(this);
    }

    @Override
    protected void handleOnDestroy() {
        current = null;
    }

    @PluginMethod
    public void open(PluginCall call) {
        String raw = call.getString("url");
        if (raw == null) {
            call.reject("A http or https url is required");
            return;
        }
        raw = raw.trim();
        Uri uri = raw.isEmpty() ? null : Uri.parse(raw);
        String scheme = uri == null || uri.getScheme() == null
            ? ""
            : uri.getScheme().toLowerCase(Locale.ROOT);
        if (uri == null || (!scheme.equals("http") && !scheme.equals("https"))) {
            call.reject("A http or https url is required");
            return;
        }

        Intent intent = new Intent(getContext(), WardenBrowserActivity.class);
        intent.putExtra(WardenBrowserActivity.EXTRA_URL, raw);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (Exception error) {
            call.reject("Could not open the browser: " + error.getMessage());
            return;
        }
        call.resolve();
    }
}
