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
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.VideoView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.util.UUID;

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
    private static final String SECONDS = "X-Polaris-View-Seconds";
    private static final String WATERMARK = "X-Polaris-Watermark";

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
        String address = origin + "/api/chat/attachments/" + attachment + "/once";
        try {
            PolarisHttp.Answer file = PolarisHttp.signed(this, origin, address, "view-once", attachment,
                    getString(R.string.view_once_failed), MAX_BYTES, SECONDS, WATERMARK);
            main.post(() -> show(file));
        } catch (PolarisHttp.Refused refused) {
            main.post(() -> fail(refused.getMessage()));
        } catch (Exception failed) {
            main.post(() -> fail(getString(R.string.view_once_failed)));
        }
    }

    private void show(PolarisHttp.Answer file) {
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
        String mark = file.headers.get(WATERMARK);
        if (mark != null) {
            try {
                mark = URLDecoder.decode(mark, "UTF-8");
            } catch (java.io.UnsupportedEncodingException | IllegalArgumentException unreadable) {
                mark = null;
            }
        }
        if (mark != null && !mark.isEmpty()) watermark(mark);
        String seconds = file.headers.get(SECONDS);
        int timer = seconds != null && seconds.matches("[0-9]{1,3}") ? Integer.parseInt(seconds) : 0;
        if (timer > 0) {
            left = timer;
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
}
