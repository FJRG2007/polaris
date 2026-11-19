package app.polaris.mobile;

import android.webkit.JavascriptInterface;

/**
 * What the page can ask of the app, as `window.polarisMobile`: which app and version it is running in, the way to the
 * list of Polaris servers, where the last picked file came from, and opening a photo sent to be seen once. Nothing here
 * hands the page anything it could not already see: a view-once file is fetched and shown by the app, never given to
 * the page.
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

    /** "camera" when the file picker's last answer was taken with the camera just now, "gallery" for anything picked
     *  from the phone, and "" before anything was picked. */
    @JavascriptInterface
    public String lastPickSource() {
        return activity.lastPickSource();
    }

    /** Whether this app can open a view-once photo or video: the page offers the button only when it can. */
    @JavascriptInterface
    public boolean canViewOnce() {
        return true;
    }

    @JavascriptInterface
    public void openViewOnce(String attachmentId) {
        if (attachmentId == null || !attachmentId.matches("[0-9a-f-]{36}")) return;
        activity.runOnUiThread(() -> activity.openViewOnce(attachmentId));
    }
}
