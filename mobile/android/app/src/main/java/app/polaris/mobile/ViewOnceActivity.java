package app.polaris.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.VideoView;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/**
 * A photo or a video sent to be seen once, shown by the app itself rather than by the page: the bytes are fetched
 * here with a request this phone signed, drawn in a window Android keeps out of screenshots, recordings and the recent
 * apps list, and forgotten when the window closes. Leaving it - the timer running out, the back button, another app -
 * ends it; there is no second look.
 */
public final class ViewOnceActivity extends Activity {
    static final String EXTRA_ORIGIN = "origin";
    static final String EXTRA_ATTACHMENT = "attachment";
    private static final int MAX_BYTES = 100 * 1024 * 1024;

    private final Handler main = new Handler(Looper.getMainLooper());
    private FrameLayout frame;
    private ProgressBar loading;
    private TextView countdown;
    private File played;
    private int left;
    private boolean shown;

    static Intent intent(Activity from, String origin, String attachmentId) {
        return new Intent(from, ViewOnceActivity.class)
                .putExtra(EXTRA_ORIGIN, origin)
                .putExtra(EXTRA_ATTACHMENT, attachmentId);
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // Before anything is drawn: no screenshot, no screen recording, no thumbnail in the recent apps.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.BLACK);
        loading = new ProgressBar(this);
        frame.addView(loading, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        setContentView(frame);

        String origin = getIntent().getStringExtra(EXTRA_ORIGIN);
        String attachment = getIntent().getStringExtra(EXTRA_ATTACHMENT);
        if (origin == null || attachment == null || !attachment.matches("[0-9a-f-]{36}")) {
            finish();
            return;
        }
        new Thread(() -> fetch(origin, attachment), "view-once").start();
    }

    private void fetch(String origin, String attachment) {
        String base = origin + "/api/chat/attachments/" + attachment + "/once";
        try {
            String key = DeviceKey.publicKey();
            JSONObject register = new JSONObject().put("publicKey", key).put("platform", "android");
            Answer registered = request(origin + "/api/mobile/device-key", "POST", register.toString());
            if (registered.status >= 400) throw new Refused(registered.error());
            Answer challenge = request(base, "GET", null);
            if (challenge.status >= 400) throw new Refused(challenge.error());
            String nonce = new JSONObject(new String(challenge.body, StandardCharsets.UTF_8)).getString("challenge");
            JSONObject proof = new JSONObject()
                    .put("challenge", nonce)
                    .put("publicKey", key)
                    .put("signature", DeviceKey.sign("view-once:" + attachment + ":" + nonce));
            Answer file = request(base, "POST", proof.toString());
            if (file.status >= 400) throw new Refused(file.error());
            main.post(() -> show(file));
        } catch (Refused refused) {
            main.post(() -> fail(refused.getMessage()));
        } catch (Exception failed) {
            main.post(() -> fail(getString(R.string.view_once_failed)));
        }
    }

    private void show(Answer file) {
        if (isFinishing()) return;
        loading.setVisibility(View.GONE);
        String type = file.type == null ? "" : file.type;
        if (type.startsWith("video/")) {
            try {
                played = new File(getCacheDir(), "once-" + UUID.randomUUID() + ".mp4");
                try (OutputStream out = new FileOutputStream(played)) {
                    out.write(file.body);
                }
            } catch (IOException failed) {
                fail(getString(R.string.view_once_failed));
                return;
            }
            VideoView video = new VideoView(this);
            frame.addView(video, 0, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
            video.setVideoPath(played.getAbsolutePath());
            video.setOnCompletionListener(player -> finish());
            video.setOnErrorListener((player, what, extra) -> {
                fail(getString(R.string.view_once_failed));
                return true;
            });
            video.start();
        } else {
            Bitmap picture = decode(file.body);
            if (picture == null) {
                fail(getString(R.string.view_once_failed));
                return;
            }
            ImageView image = new ImageView(this);
            image.setScaleType(ImageView.ScaleType.FIT_CENTER);
            image.setImageBitmap(picture);
            frame.addView(image, 0, new FrameLayout.LayoutParams(-1, -1));
        }
        shown = true;
        frame.setOnClickListener(view -> finish());
        if (file.watermark != null && !file.watermark.isEmpty()) watermark(file.watermark);
        if (file.seconds > 0) {
            left = file.seconds;
            countdown = label(Gravity.TOP | Gravity.END, 18);
            tick();
        }
    }

    /** Who is looking and when, across the picture: a photo of the screen taken with another phone still says. */
    private void watermark(String text) {
        for (int gravity : new int[] {Gravity.TOP | Gravity.START, Gravity.CENTER, Gravity.BOTTOM | Gravity.END}) {
            TextView mark = label(gravity, 14);
            mark.setText(text);
            mark.setAlpha(0.35f);
            mark.setRotation(-20);
        }
    }

    private TextView label(int gravity, int size) {
        TextView view = new TextView(this);
        view.setTextColor(Color.WHITE);
        view.setTextSize(size);
        view.setShadowLayer(4, 0, 0, Color.BLACK);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        view.setPadding(pad, pad * 3, pad, pad * 3);
        frame.addView(view, new FrameLayout.LayoutParams(-2, -2, gravity));
        return view;
    }

    private void tick() {
        if (isFinishing()) return;
        if (left <= 0) {
            finish();
            return;
        }
        countdown.setText(String.valueOf(left));
        left--;
        main.postDelayed(this::tick, 1000);
    }

    /** Decoded no larger than the screen: a 48-megapixel photo held whole would not fit in memory. */
    private Bitmap decode(byte[] bytes) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        DisplayMetrics screen = getResources().getDisplayMetrics();
        int longest = Math.max(screen.widthPixels, screen.heightPixels) * 2;
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / sample > longest) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
    }

    private void fail(String message) {
        if (isFinishing()) return;
        loading.setVisibility(View.GONE);
        TextView text = label(Gravity.CENTER, 16);
        text.setText(message);
        text.setGravity(Gravity.CENTER);
        frame.setOnClickListener(view -> finish());
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Once it has been shown, looking away is the end of it.
        if (shown) finish();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (played != null) played.delete();
        super.onDestroy();
    }

    private static final class Refused extends Exception {
        Refused(String message) {
            super(message);
        }
    }

    private final class Answer {
        int status;
        String type;
        String watermark;
        int seconds;
        byte[] body = new byte[0];

        String error() {
            try {
                String said = new JSONObject(new String(body, StandardCharsets.UTF_8)).optString("error", "");
                if (!said.isEmpty()) return said;
            } catch (Exception ignored) {
                // Not JSON: say it in the app's own words.
            }
            return getString(R.string.view_once_failed);
        }
    }

    /** One request to this Polaris, signed in as the page is. */
    private Answer request(String address, String method, String json) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            connection.setRequestMethod(method);
            String cookie = CookieManager.getInstance().getCookie(address);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("User-Agent", AppAgent.of(this));
            if (json != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                }
            }
            Answer answer = new Answer();
            answer.status = connection.getResponseCode();
            answer.type = connection.getContentType();
            String seconds = connection.getHeaderField("X-Polaris-View-Seconds");
            if (seconds != null && seconds.matches("\\d{1,3}")) answer.seconds = Integer.parseInt(seconds);
            String mark = connection.getHeaderField("X-Polaris-Watermark");
            if (mark != null) answer.watermark = URLDecoder.decode(mark, "UTF-8");
            InputStream in = answer.status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (in != null) {
                try (InputStream stream = in) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] chunk = new byte[64 * 1024];
                    int read;
                    while ((read = stream.read(chunk)) != -1) {
                        if (out.size() + read > MAX_BYTES) throw new IOException("too large");
                        out.write(chunk, 0, read);
                    }
                    answer.body = out.toByteArray();
                }
            }
            return answer;
        } finally {
            connection.disconnect();
        }
    }
}
