package app.polaris.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
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
import android.widget.ImageButton;
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
 * A photo, a video or an audio sent to be seen once, shown by the app itself rather than by the page: the bytes are fetched
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
    private static final String CAPTURED = "X-Polaris-Captured";

    private final Handler main = new Handler(Looper.getMainLooper());
    private FrameLayout frame;
    private ProgressBar loading;
    private TextView countdown;
    private ProgressBar progress;
    private VideoView video;
    private File played;
    /** The timer's end, on the uptime clock; zero while there is no timer. */
    private long endsAt;
    private long timerMs;
    private boolean shown;
    /** How often the bar along the top moves: smooth enough to read as a sweep. */
    private static final int FRAME_MS = 50;

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
        // The countdown and the watermark stay clear of a cutout in landscape; the black runs on behind it.
        SystemInsets.pad(frame);

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
                    getString(R.string.view_once_failed), MAX_BYTES, SECONDS, WATERMARK, CAPTURED);
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
        boolean audio = type.startsWith("audio/");
        if (type.startsWith("video/") || audio) {
            try {
                // No extension to trust: the player reads the container from the bytes.
                played = new File(getCacheDir(), "once-" + UUID.randomUUID() + ".media");
                try (OutputStream out = new FileOutputStream(played)) {
                    out.write(file.body);
                }
            } catch (IOException failed) {
                fail(getString(R.string.view_once_failed));
                return;
            }
            video = new VideoView(this);
            frame.addView(video, 0, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
            video.setVideoPath(played.getAbsolutePath());
            video.setOnCompletionListener(player -> finish());
            video.setOnErrorListener((player, what, extra) -> {
                fail(getString(R.string.view_once_failed));
                return true;
            });
            video.start();
            if (audio) {
                // Nothing to look at while it plays: say what it is, over the same black.
                TextView playing = new TextView(this);
                playing.setText(R.string.view_once_audio);
                playing.setTextColor(Color.WHITE);
                playing.setTextSize(18);
                frame.addView(playing, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
            }
        } else {
            Bitmap picture = decode(file.body);
            if (picture == null) {
                fail(getString(R.string.view_once_failed));
                return;
            }
            // Pinch, pan and double tap to look closer; leaving is the close button or back.
            ZoomImageView image = new ZoomImageView(this);
            image.setImageBitmap(picture);
            frame.addView(image, 0, new FrameLayout.LayoutParams(-1, -1));
        }
        shown = true;
        // No tap-anywhere-to-close: a pinch to zoom started with a tap and threw the photo away.
        topBar();
        String mark = file.headers.get(WATERMARK);
        if (mark != null) {
            try {
                mark = URLDecoder.decode(mark, "UTF-8");
            } catch (java.io.UnsupportedEncodingException | IllegalArgumentException unreadable) {
                mark = null;
            }
        }
        if (mark != null && !mark.isEmpty()) watermark(mark);
        // Taken there and then, or picked from the gallery: said under the bar, the way Snapchat marks it.
        String captured = file.headers.get(CAPTURED);
        if ("camera".equals(captured) || "gallery".equals(captured)) {
            TextView source = new TextView(this);
            source.setText("camera".equals(captured) ? R.string.view_once_camera : R.string.view_once_gallery);
            source.setTextColor(Color.WHITE);
            source.setTextSize(13);
            source.setShadowLayer(4, 0, 0, Color.BLACK);
            int pad = (int) (12 * getResources().getDisplayMetrics().density);
            FrameLayout.LayoutParams corner = new FrameLayout.LayoutParams(-2, pad * 4, Gravity.TOP | Gravity.START);
            corner.setMargins(pad, pad * 2, 0, 0);
            source.setGravity(Gravity.CENTER_VERTICAL);
            frame.addView(source, corner);
        }
        String seconds = file.headers.get(SECONDS);
        int timer = seconds != null && seconds.matches("[0-9]{1,3}") ? Integer.parseInt(seconds) : 0;
        if (timer > 0) {
            timerMs = timer * 1000L;
            endsAt = android.os.SystemClock.uptimeMillis() + timerMs;
        }
        if (timer > 0 || video != null) tick();
        else progress.setVisibility(View.GONE);
    }

    /**
     * Along the top, the way Instagram and Telegram show a story: a bar that runs
     * out with the time left (or with the video), the seconds beside it, and a close
     * button - leaving is always one tap away, not only when the time is up.
     */
    private void topBar() {
        float density = getResources().getDisplayMetrics().density;
        int pad = (int) (12 * density);
        int close = (int) (48 * density);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(1000);
        progress.setProgress(1000);
        progress.setProgressTintList(ColorStateList.valueOf(Color.WHITE));
        progress.setProgressBackgroundTintList(ColorStateList.valueOf(Color.argb(90, 255, 255, 255)));
        FrameLayout.LayoutParams line = new FrameLayout.LayoutParams(-1, (int) (3 * density), Gravity.TOP);
        line.setMargins(pad, pad, pad, 0);
        frame.addView(progress, line);

        ImageButton shut = new ImageButton(this);
        shut.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
        shut.setColorFilter(Color.WHITE);
        shut.setBackgroundColor(Color.TRANSPARENT);
        shut.setContentDescription(getString(R.string.view_once_close));
        shut.setOnClickListener(view -> finish());
        FrameLayout.LayoutParams corner = new FrameLayout.LayoutParams(close, close, Gravity.TOP | Gravity.END);
        corner.setMargins(0, pad * 2, pad / 2, 0);
        frame.addView(shut, corner);

        countdown = new TextView(this);
        countdown.setTextColor(Color.WHITE);
        countdown.setTextSize(16);
        countdown.setShadowLayer(4, 0, 0, Color.BLACK);
        countdown.setGravity(Gravity.CENTER_VERTICAL);
        FrameLayout.LayoutParams beside = new FrameLayout.LayoutParams(-2, close, Gravity.TOP | Gravity.END);
        beside.setMargins(0, pad * 2, close + pad / 2, 0);
        frame.addView(countdown, beside);
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
        float share;
        if (timerMs > 0) {
            long remaining = endsAt - android.os.SystemClock.uptimeMillis();
            if (remaining <= 0) {
                finish();
                return;
            }
            share = remaining / (float) timerMs;
            countdown.setText(String.valueOf((remaining + 999) / 1000));
        } else {
            // A video or voice note with no timer: the bar follows what is left of it.
            int length = video.getDuration();
            share = length > 0 ? 1f - video.getCurrentPosition() / (float) length : 1f;
        }
        progress.setProgress(Math.round(Math.max(0f, Math.min(1f, share)) * 1000));
        main.postDelayed(this::tick, FRAME_MS);
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

    /** Android 14 and later say when the screen is captured: the photo closes, as it does in Telegram. */
    private final Object captured = android.os.Build.VERSION.SDK_INT >= 34
            ? (Activity.ScreenCaptureCallback) this::finish
            : null;

    @Override
    protected void onStart() {
        super.onStart();
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            registerScreenCaptureCallback(getMainExecutor(), (Activity.ScreenCaptureCallback) captured);
        }
    }

    @Override
    protected void onStop() {
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            unregisterScreenCaptureCallback((Activity.ScreenCaptureCallback) captured);
        }
        super.onStop();
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
