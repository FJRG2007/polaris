package app.polaris.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
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
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;

/**
 * Polaris itself, in a window of its own: the instance the phone was pointed at, signed in like any browser and kept
 * signed in. The page is the instance's, so it is always the version the server runs; the app adds what a browser tab
 * cannot - the camera and microphone for calls, files picked and saved, the back button, and links to anywhere else
 * opening in the browser instead of inside Polaris.
 */
public final class MainActivity extends Activity {
    private static final int PICK_FILES = 1;
    private static final int MEDIA_PERMISSIONS = 2;

    private WebView web;
    private View failure;
    private TextView failureText;
    private ProgressBar loading;
    private String origin;
    private ValueCallback<Uri[]> picking;
    private PermissionRequest asking;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        origin = ServerStore.origin(this);
        if (origin == null) {
            startActivity(new Intent(this, ServerActivity.class));
            finish();
            return;
        }
        setContentView(R.layout.activity_main);
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
        if (saved != null) web.restoreState(saved);
        if (saved == null || web.getUrl() == null) web.loadUrl(start(getIntent()));
        UpdateCheck.maybeRun(this);
    }

    /** A link to this Polaris that opened the app (polaris-mobile://, a shared address) lands on its page. */
    private String start(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data != null && ServerAddress.sameOrigin(origin, data.toString())) return data.toString();
        return origin + "/";
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView view) {
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
        settings.setUserAgentString(settings.getUserAgentString() + " PolarisMobile/" + BuildConfig.VERSION_NAME + " (Android)");

        CookieManager cookies = CookieManager.getInstance();
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
        public void onPageStarted(WebView view, String url, Bitmap icon) {
            loading.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            loading.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
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
            Intent intent = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(intent, PICK_FILES);
            } catch (ActivityNotFoundException none) {
                picking = null;
                return false;
            }
            return true;
        }
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
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                files = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < files.length; i++) files[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                files = new Uri[] {data.getData()};
            }
        }
        picking.onReceiveValue(files);
        picking = null;
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
            String cookie = CookieManager.getInstance().getCookie(url);
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
        startActivity(new Intent(this, ServerActivity.class));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String next = ServerStore.origin(this);
        if (next != null && !next.equals(origin)) {
            // Pointed at another Polaris: start over there.
            origin = next;
            web.clearHistory();
            web.loadUrl(origin + "/");
        } else if (intent.getData() != null) {
            web.loadUrl(start(intent));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        String next = ServerStore.origin(this);
        if (web != null && next != null && !next.equals(origin)) {
            origin = next;
            web.clearHistory();
            web.loadUrl(origin + "/");
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

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
