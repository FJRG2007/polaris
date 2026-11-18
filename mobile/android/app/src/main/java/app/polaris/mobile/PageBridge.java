package app.polaris.mobile;

import android.webkit.JavascriptInterface;

/**
 * What the page can ask of the app, as `window.polarisMobile`: which app and version it is running in, and the way
 * back to the address screen. Nothing here reads or changes anything the page could not already see.
 */
final class PageBridge {
    private final MainActivity activity;

    PageBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String platform() {
        return "android";
    }

    @JavascriptInterface
    public String version() {
        return BuildConfig.VERSION_NAME;
    }

    @JavascriptInterface
    public void changeServer() {
        activity.runOnUiThread(activity::changeServer);
    }
}
