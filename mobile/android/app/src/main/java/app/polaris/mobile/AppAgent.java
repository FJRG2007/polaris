package app.polaris.mobile;

import android.content.Context;
import android.webkit.WebSettings;

/**
 * The User-Agent every request from this app carries, the page's and the app's own alike.
 *
 * The instance ties a session to the browser and system it was opened in, and a request whose agent reads as another
 * client is refused and the session revoked as stolen. So the connections the app makes outside the page (the
 * notification service, the view-once screen) present exactly what the page does.
 */
final class AppAgent {
    private AppAgent() {
    }

    static String of(Context context) {
        return WebSettings.getDefaultUserAgent(context) + " PolarisMobile/" + BuildConfig.VERSION_NAME + " (Android)";
    }
}
