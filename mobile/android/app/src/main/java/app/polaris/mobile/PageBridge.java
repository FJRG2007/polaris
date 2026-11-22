package app.polaris.mobile;

import android.net.Uri;
import android.webkit.JavascriptInterface;

/**
 * What the page can ask of the app, as `window.polarisMobile`: which app and version it is running in, the way to the
 * list of Polaris servers, where the last picked file came from, opening a photo sent to be seen once, and handing a
 * link to the phone's browser or mail app. Nothing here
 * hands the page anything it could not already see: a view-once file is fetched and shown by the app, never given to
 * the page, and the VPN's private key stays in the app.
 */
final class PageBridge {
    private final HomeActivity activity;

    PageBridge(HomeActivity activity) {
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

    /** Live location in Chat, sent by a foreground service until the given moment (epoch ms). */
    @JavascriptInterface
    public void startLiveLocation(double untilMs) {
        if (!LiveLocationService.start(activity, (long) untilMs)) activity.runOnUiThread(activity::askLocation);
    }

    @JavascriptInterface
    public void stopLiveLocation() {
        LiveLocationService.stop(activity);
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

    /** Whether this app reads the phone's gallery for the page: the + sheet shows the recent photos only then. */
    @JavascriptInterface
    public boolean canMedia() {
        return true;
    }

    /** The gallery (`DeviceMedia`): `op` is access, request, manage, settings, list, thumb or read, `args` its JSON. The
     *  answer comes back to `window.__polarisMobileMedia(id, json)`. */
    @JavascriptInterface
    public void mediaCall(String id, String op, String args) {
        if (!validId(id) || op == null || op.length() > 16 || args == null || args.length() > 1024) return;
        org.json.JSONObject parsed;
        try {
            parsed = new org.json.JSONObject(args);
        } catch (org.json.JSONException unreadable) {
            parsed = new org.json.JSONObject();
        }
        org.json.JSONObject input = parsed;
        activity.runOnUiThread(() -> activity.mediaCall(id, op, input));
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

    /** Keep the window out of screenshots, recordings and the recent apps list while the page shows something private
     *  (a profile photo full size), the way the view-once screen always is. */
    @JavascriptInterface
    public void protectScreen(boolean on) {
        activity.runOnUiThread(() -> activity.protectScreen(on));
    }

    /** The season the page decorates with ("winter", "halloween", ...), or "" for none: the launcher icon wears it
     *  from the next time the person leaves the app (SeasonIcon). */
    @JavascriptInterface
    public void setSeasonIcon(String season) {
        if (season == null || season.length() > 32) return;
        SeasonIcon.remember(activity, season);
        // A page from before the official flag: its season counts as this server's own.
        SeasonIcon.report(activity, ServerStore.origin(activity), season, false);
    }

    /** The same, with whether the season is Polaris's own calendar's, kept per server so that several servers settle
     *  on one icon instead of taking turns (SeasonIcon.wantedAcross). The server is the one this app has on screen,
     *  not one the page names. */
    @JavascriptInterface
    public void reportSeasonIcon(String season, boolean official) {
        if (season == null || season.length() > 32) return;
        SeasonIcon.report(activity, ServerStore.origin(activity), season, official);
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

    /** Whether this app runs the VPN itself: the VPN page offers Connect only when it does. */
    @JavascriptInterface
    public boolean canVpn() {
        return true;
    }

    @JavascriptInterface
    public String vpnDeviceName() {
        return VpnTunnel.deviceName(activity);
    }

    /** The public half of this phone's VPN key; the private one never leaves the app. "" if none can be made. */
    @JavascriptInterface
    public String vpnKey() {
        return activity.vpnKey();
    }

    /** Connect with what Polaris answered; the outcome comes back to `window.__polarisMobileVpn(id, error)`. */
    @JavascriptInterface
    public void vpnUp(String id, String json) {
        if (!validId(id) || json == null || json.length() > 16 * 1024) return;
        activity.runOnUiThread(() -> activity.vpnUp(id, json));
    }

    @JavascriptInterface
    public void vpnDown(String id) {
        if (!validId(id)) return;
        activity.runOnUiThread(() -> activity.vpnDown(id));
    }

    /** `{"nodeId": ...}`: the place the tunnel is up to, null while it is off. */
    @JavascriptInterface
    public String vpnStatus() {
        return VpnTunnel.get(activity).statusJson();
    }

    private static boolean validId(String id) {
        return id != null && id.matches("[A-Za-z0-9-]{1,40}");
    }

    /** Whether the page has a back of its own on screen; while it does, the system back is the page's to take. */
    @JavascriptInterface
    public void swipeBack(boolean available) {
        activity.runOnUiThread(() -> activity.setPageSwipeBack(available));
    }
}
