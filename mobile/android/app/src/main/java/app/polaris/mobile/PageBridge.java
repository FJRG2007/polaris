package app.polaris.mobile;

import android.net.Uri;
import android.webkit.JavascriptInterface;

/**
 * What the page can ask of the app, as `window.polarisMobile`: which app and version it is running in, the way to the
 * list of Polaris servers, where the last picked file came from, opening a photo sent to be seen once, and handing a
 * link to the phone's browser or mail app. Nothing here
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

    /** Polaris Vault autofill on this phone: the page offers its button only where this answers true. */
    @JavascriptInterface
    public boolean canVaultAutofill() {
        return true;
    }

    @JavascriptInterface
    public void openVaultAutofill() {
        activity.runOnUiThread(() -> activity.startActivity(new android.content.Intent(activity, VaultActivity.class)));
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

    /** A link the page opens outside itself. Only the web and mail leave: any other scheme would launch whatever app
     *  claims it. A WebView has no tabs, and a link in a sandboxed frame (a mail body) cannot open a window of its
     *  own, so the page hands every outside link here. */
    @JavascriptInterface
    public void openExternal(String url) {
        Uri uri = externalUri(url);
        if (uri != null) activity.runOnUiThread(() -> activity.openOutside(uri));
    }

    /** The address as a web or mail link, or null for anything else. */
    static Uri externalUri(String url) {
        if (url == null || url.length() > 20_000) return null;
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (scheme == null) return null;
        switch (scheme.toLowerCase(java.util.Locale.ROOT)) {
            case "http":
            case "https":
                return uri.getHost() == null || uri.getHost().isEmpty() ? null : uri;
            case "mailto":
                return uri;
            default:
                return null;
        }
    }
}
