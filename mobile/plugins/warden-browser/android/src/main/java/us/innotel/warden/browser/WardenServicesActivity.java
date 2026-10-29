package us.innotel.warden.browser;

import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;

/**
 * The operator's services — chat and mail — in a session of their own.
 *
 * <p>This is the same surface with a different data directory, and it runs in its
 * own process. Both halves are needed for one reason: Android gives an app one
 * cookie jar per process, so a private page's teardown ({@code removeAllCookies}
 * plus {@code WebStorage.deleteAllData}) would sign the operator out of every
 * chat app they had open. A separate process lets {@code WebView} keep a second,
 * independent store ({@code app_webview_services}), which the private wipe cannot
 * reach.
 *
 * <p>{@link WebView#setDataDirectorySuffix} has to run before this process
 * creates its first {@code WebView}, which is why the subclass sets it before
 * {@code super.onCreate}. It exists from API 28; on older releases the two
 * sessions share one store, and clearing the browser clears the services too.
 */
public class WardenServicesActivity extends WardenBrowserActivity {

    /** Wipe this process's store and leave, without showing a window. */
    public static final String EXTRA_CLEAR = "us.innotel.warden.SERVICES_CLEAR";

    private static final String SUFFIX = "services";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                WebView.setDataDirectorySuffix(SUFFIX);
            } catch (IllegalStateException alreadyOpen) {
                // Another WebView in this process got there first, so the suffix
                // no longer applies. The surface still works; the isolation is
                // what is lost, and the docs say so.
            }
        }

        if (getIntent().getBooleanExtra(EXTRA_CLEAR, false)) {
            clearEverything();
            // No URL: the parent finishes the activity before it builds a page.
            super.onCreate(savedInstanceState);
            return;
        }
        super.onCreate(savedInstanceState);
    }

    /**
     * Sign out of everything, from this process.
     *
     * <p>The cookie jar and web storage belong to the process that initialised
     * them, so this cannot be done from the shell: it is a call into the service
     * process that wipes its own store and leaves.
     */
    private void clearEverything() {
        try {
            CookieManager cookies = CookieManager.getInstance();
            cookies.removeAllCookies(null);
            cookies.flush();
            WebStorage.getInstance().deleteAllData();
            WebView probe = new WebView(this);
            probe.clearCache(true);
            probe.clearFormData();
            probe.destroy();
        } catch (Exception error) {
            // A clear that fails must not leave an invisible screen behind.
        }
    }
}
