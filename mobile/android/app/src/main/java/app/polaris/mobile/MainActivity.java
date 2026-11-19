package app.polaris.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Polaris itself, in a window of its own: the instance the phone was pointed at, signed in like any browser and kept
 * signed in. The page is the instance's, so it is always the version the server runs; the app adds what a browser tab
 * cannot - the camera and microphone for calls, files picked and saved, the back button, and links to anywhere else
 * opening in the browser instead of inside Polaris.
 */
public final class MainActivity extends Activity {
    private static final int PICK_FILES = 1;
    private static final int MEDIA_PERMISSIONS = 2;
    private static final int CAMERA_FOR_PICK = 3;
    private static final int NOTIFICATIONS = 4;
    private static final String SAVED_HOST = "polaris.host";

    private WebView web;
    private View failure;
    private TextView failureText;
    private ProgressBar loading;
    private ServerStore.Host host;
    private String origin;
    private ValueCallback<Uri[]> picking;
    private PermissionRequest asking;
    private Pick pendingPick;
    private File photoTaken;
    private File videoTaken;
    private volatile String pickSource = "";
    /** Back while the page has somewhere to go back to (Android 13+). Registered only then, so that on the first
     *  page the system's own back - and its predictive animation home - is what happens. */
    private Object pageBack;
    private boolean pageBackRegistered;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // Before any WebView exists: a removed Polaris's profile can only be deleted while nothing has it open.
        HostProfiles.sweep(this);
        host = ServerStore.active(this);
        if (host == null) {
            startActivity(new Intent(this, ServerActivity.class));
            finish();
            return;
        }
        origin = host.origin;
        setContentView(R.layout.activity_main);
        SystemInsets.pad(findViewById(R.id.root));
        web = findViewById(R.id.web);
        failure = findViewById(R.id.failure);
        failureText = findViewById(R.id.failure_text);
        loading = findViewById(R.id.loading);
        Button retry = findViewById(R.id.retry);
        Button change = findViewById(R.id.change_server);
        retry.setOnClickListener(view -> {
            failure.setVisibility(View.GONE);
            web.reload();
        });
        change.setOnClickListener(view -> changeServer());

        configure(web);
        // A page saved for another Polaris is not restored into this one's window.
        if (saved != null && host.id.equals(saved.getString(SAVED_HOST))) web.restoreState(saved);
        else saved = null;
        if (saved == null || web.getUrl() == null) web.loadUrl(start(getIntent()));
        UpdateCheck.maybeRun(this);
        listenForNotices();
    }

    /** Messages and calls as notifications while the app is closed, once Android lets them through. */
    private void listenForNotices() {
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS);
            return;
        }
        NoticeService.start(this);
        askToStayAwake();
    }

    /**
     * Once: ask Android to leave Polaris out of battery optimisation. Without it the phone puts the connection the
     * notices arrive on to sleep after a while in the pocket, and a message shows up only when the app is opened -
     * the reason apps that do not go through Google's push (ntfy, Conversations, Signal without Play services) ask
     * for exactly this.
     */
    private void askToStayAwake() {
        PowerManager power = getSystemService(PowerManager.class);
        if (power == null || power.isIgnoringBatteryOptimizations(getPackageName())) return;
        android.content.SharedPreferences asked = getSharedPreferences("notices", MODE_PRIVATE);
        if (asked.getBoolean("battery_asked", false)) return;
        asked.edit().putBoolean("battery_asked", true).apply();
        new AlertDialog.Builder(this)
                .setTitle(R.string.battery_title)
                .setMessage(R.string.battery_body)
                .setPositiveButton(R.string.battery_allow, (dialog, which) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                                .setData(Uri.parse("package:" + getPackageName())));
                    } catch (ActivityNotFoundException missing) {
                        // A phone without the prompt: its battery settings list the app instead.
                        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    }
                })
                .setNegativeButton(R.string.battery_later, null)
                .show();
    }

    /** A link to this Polaris that opened the app (polaris-mobile://, a shared address) lands on its page. */
    private String start(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data != null && ServerAddress.sameOrigin(origin, data.toString())) return data.toString();
        return origin + "/";
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView view) {
        // First, before anything else touches the WebView: which Polaris's cookies and storage the page sees.
        HostProfiles.apply(view, host);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // A call starts its audio from a tap that already happened on the page.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        // How the instance tells this app from a browser on its sessions screen.
        settings.setUserAgentString(AppAgent.of(this));
        // Passkeys on the page, answered by the phone's own credential manager (the instance publishes the app in
        // its Digital Asset Links, which is what lets this app use its passkeys).
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
        }

        CookieManager cookies = HostProfiles.cookies(host);
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, true);

        view.addJavascriptInterface(new PageBridge(this), "polarisMobile");
        view.setWebViewClient(new Client());
        view.setWebChromeClient(new Chrome());
        view.setDownloadListener((url, agent, disposition, mime, length) -> download(url, agent, disposition, mime));
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (ServerAddress.sameOrigin(origin, url)) return false;
            openOutside(request.getUrl());
            return true;
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            syncBack();
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap icon) {
            loading.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            loading.setVisibility(View.GONE);
            HostProfiles.cookies(host).flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            failureText.setText(getString(R.string.page_unreachable, origin));
            failure.setVisibility(View.VISIBLE);
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            // Only the instance itself may ask for the camera or the microphone.
            if (!ServerAddress.sameOrigin(origin, request.getOrigin().toString())) {
                request.deny();
                return;
            }
            List<String> needed = new ArrayList<>();
            for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needed.add(Manifest.permission.CAMERA);
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needed.add(Manifest.permission.RECORD_AUDIO);
            }
            List<String> missing = new ArrayList<>();
            for (String permission : needed) {
                if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
            }
            if (missing.isEmpty()) {
                grantAllowed(request);
                return;
            }
            if (asking != null) asking.deny();
            asking = request;
            requestPermissions(missing.toArray(new String[0]), MEDIA_PERMISSIONS);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (picking != null) picking.onReceiveValue(null);
            picking = callback;
            Pick pick = new Pick(params);
            // The camera is offered beside the gallery for a photo or a video, which needs the camera permission
            // first: Android refuses the camera app to an app that declares it and has not been given it.
            if (pick.wantsMedia() && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                pendingPick = pick;
                requestPermissions(new String[] {Manifest.permission.CAMERA}, CAMERA_FOR_PICK);
                return true;
            }
            return choose(pick);
        }
    }

    /** What the page's file input asked for, kept while Android asks for the camera. */
    private static final class Pick {
        final Intent intent;
        final boolean multiple;
        final boolean images;
        final boolean videos;

        Pick(WebChromeClient.FileChooserParams params) {
            intent = params.createIntent();
            multiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
            boolean any = true;
            boolean image = false;
            boolean video = false;
            for (String type : params.getAcceptTypes()) {
                if (type == null || type.trim().isEmpty()) continue;
                any = false;
                for (String part : type.split(",")) {
                    String accept = part.trim();
                    if (accept.equals("*/*")) any = true;
                    if (accept.startsWith("image/") || accept.matches("\\.(jpe?g|png|heic|webp)")) image = true;
                    if (accept.startsWith("video/") || accept.matches("\\.(mp4|mov|webm)")) video = true;
                }
            }
            images = any || image;
            videos = any || video;
        }

        boolean wantsMedia() {
            return images || videos;
        }
    }

    private boolean choose(Pick pick) {
        Intent gallery = pick.intent;
        if (pick.multiple) gallery.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        photoTaken = null;
        videoTaken = null;
        List<Intent> cameras = new ArrayList<>();
        if (pick.wantsMedia() && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            if (pick.images) {
                photoTaken = new File(CaptureProvider.folder(this), UUID.randomUUID() + ".jpg");
                cameras.add(capture(MediaStore.ACTION_IMAGE_CAPTURE, photoTaken));
            }
            if (pick.videos) {
                videoTaken = new File(CaptureProvider.folder(this), UUID.randomUUID() + ".mp4");
                cameras.add(capture(MediaStore.ACTION_VIDEO_CAPTURE, videoTaken));
            }
        }
        Intent chooser = Intent.createChooser(gallery, null);
        if (!cameras.isEmpty()) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, cameras.toArray(new Intent[0]));
        try {
            startActivityForResult(chooser, PICK_FILES);
        } catch (ActivityNotFoundException none) {
            picking.onReceiveValue(null);
            picking = null;
            return false;
        }
        return true;
    }

    private Intent capture(String action, File into) {
        Uri uri = CaptureProvider.uriFor(into);
        Intent intent = new Intent(action).putExtra(MediaStore.EXTRA_OUTPUT, uri);
        intent.setClipData(ClipData.newRawUri("", uri));
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    /** Read once: a file pasted or dropped after a pick is not that pick's. */
    String lastPickSource() {
        String source = pickSource;
        pickSource = "";
        return source;
    }

    void openViewOnce(String attachmentId) {
        startActivity(ViewOnceActivity.intent(this, origin, attachmentId));
    }

    /** Grants what Android already allows, and nothing it does not. */
    private void grantAllowed(PermissionRequest request) {
        List<String> granted = new ArrayList<>();
        for (String resource : request.getResources()) {
            boolean video = PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource);
            boolean audio = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource);
            if (video && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
            if (audio && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
        }
        if (granted.isEmpty()) request.deny();
        else request.grant(granted.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code == NOTIFICATIONS) {
            NoticeService.start(this);
            askToStayAwake();
            return;
        }
        if (code == CAMERA_FOR_PICK) {
            Pick pick = pendingPick;
            pendingPick = null;
            if (pick != null && picking != null) choose(pick);
            return;
        }
        if (code != MEDIA_PERMISSIONS || asking == null) return;
        PermissionRequest request = asking;
        asking = null;
        grantAllowed(request);
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code != PICK_FILES || picking == null) {
            super.onActivityResult(code, result, data);
            return;
        }
        Uri[] files = null;
        pickSource = "";
        File taken = taken();
        if (result == RESULT_OK && taken != null) {
            // The camera wrote where it was told; what it returns in `data` varies between camera apps.
            files = new Uri[] {CaptureProvider.uriFor(taken)};
            pickSource = "camera";
        } else if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                files = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < files.length; i++) files[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                files = new Uri[] {data.getData()};
            }
            if (files != null) pickSource = "gallery";
        }
        picking.onReceiveValue(files);
        picking = null;
    }

    /** The photo or video the camera wrote, when it wrote one. */
    private File taken() {
        if (photoTaken != null && photoTaken.length() > 0) return photoTaken;
        if (videoTaken != null && videoTaken.length() > 0) return videoTaken;
        return null;
    }

    /** A file the page offers is saved to Downloads, signed in as the page is. */
    private void download(String url, String agent, String disposition, String mime) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            Toast.makeText(this, R.string.download_unsupported, Toast.LENGTH_LONG).show();
            return;
        }
        String name = URLUtil.guessFileName(url, disposition, mime);
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setMimeType(mime)
                .addRequestHeader("User-Agent", agent)
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        if (ServerAddress.sameOrigin(origin, url)) {
            String cookie = HostProfiles.cookies(host).getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
        }
        DownloadManager manager = getSystemService(DownloadManager.class);
        if (manager == null) return;
        manager.enqueue(request);
        Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
    }

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException none) {
            Toast.makeText(this, R.string.link_unsupported, Toast.LENGTH_SHORT).show();
        }
    }

    void changeServer() {
        startActivity(new Intent(this, HostsActivity.class));
    }

    /**
     * Opens the Polaris chosen now in a new window. A WebView's profile is fixed once it has loaded a page, so another
     * Polaris is never loaded into this one: the old window goes, and its notices connection with it.
     */
    static void reopen(Context context) {
        NoticeService.restart(context);
        context.startActivity(new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    }

    /** Whether another Polaris was chosen since this window opened; if so it has been reopened on that one. */
    private boolean hostChanged() {
        ServerStore.Host next = ServerStore.active(this);
        if (next == null || next.id.equals(host.id)) return false;
        reopen(this);
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (web == null || hostChanged()) return;
        if (intent.getData() != null) web.loadUrl(start(intent));
    }

    @Override
    protected void onPause() {
        NoticeService.pageVisible = false;
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        NoticeService.pageVisible = true;
        // Signed in since the last time it ran, or stopped while signed out: it reconnects with the session now held.
        NoticeService.start(this);
        DoorWidget.redrawAll(this);
        if (web != null) hostChanged();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) {
            web.saveState(out);
            out.putString(SAVED_HOST, host.id);
        }
    }

    /**
     * Android 13 and later deliver back through a callback instead of onBackPressed, and from Android 16 on an app
     * that targets it is never sent onBackPressed at all. The page's own history goes first; with none left, the
     * callback is withdrawn and the system takes the app home.
     */
    private void syncBack() {
        if (android.os.Build.VERSION.SDK_INT < 33) return;
        boolean wanted = web != null && web.canGoBack();
        if (wanted == pageBackRegistered) return;
        OnBackInvokedDispatcher dispatcher = getOnBackInvokedDispatcher();
        if (pageBack == null) {
            pageBack = (OnBackInvokedCallback) () -> {
                if (web != null && web.canGoBack()) web.goBack();
                syncBack();
            };
        }
        if (wanted) dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, (OnBackInvokedCallback) pageBack);
        else dispatcher.unregisterOnBackInvokedCallback((OnBackInvokedCallback) pageBack);
        pageBackRegistered = wanted;
    }

    /**
     * Android 12 and earlier. From 13 on the back gesture goes to the callback {@link #syncBack()} registers (the
     * manifest opts in), so this is the older systems' path only; the app has no AndroidX to take the dispatcher from.
     */
    @SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
