package app.polaris.mobile;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;
import java.lang.ref.WeakReference;

/**
 * The incoming-call screen: who is calling, Decline and Answer, shown over the lock screen and waking the display,
 * as a phone call is. Android opens it from the ringing notification's full-screen intent; Answer on the
 * notification passes through it too ({@link #ACTION_ANSWER}), so answering is one path wherever it was pressed.
 */
public final class IncomingCallActivity extends Activity {
    static final String ACTION_ANSWER = "app.polaris.mobile.CALL_ANSWER";

    /** The screen on display now, so a ring that ends elsewhere takes it down. */
    private static WeakReference<IncomingCallActivity> shown = new WeakReference<>(null);

    private String tag;

    static void closeFor(String tag) {
        IncomingCallActivity screen = shown.get();
        if (screen != null && tag != null && tag.equals(screen.tag)) screen.runOnUiThread(screen::finish);
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        tag = intent.getStringExtra(IncomingCall.EXTRA_TAG);
        if (tag == null) {
            finish();
            return;
        }
        if (ACTION_ANSWER.equals(intent.getAction())) {
            answer(intent);
            return;
        }
        shown = new WeakReference<>(this);
        setContentView(R.layout.activity_incoming_call);
        String caller = intent.getStringExtra(IncomingCall.EXTRA_CALLER);
        ((TextView) findViewById(R.id.call_caller)).setText(caller == null ? "" : caller);
        findViewById(R.id.call_decline).setOnClickListener((view) -> {
            CallDecline.decline(this, intent);
            finish();
        });
        findViewById(R.id.call_answer).setOnClickListener((view) -> answer(intent));
    }

    private void answer(Intent intent) {
        IncomingCall.stop(this, tag);
        String origin = intent.getStringExtra(IncomingCall.EXTRA_ORIGIN);
        String path = intent.getStringExtra(IncomingCall.EXTRA_PATH);
        if (origin == null || path == null || !path.startsWith("/chat/c/")) {
            finish();
            return;
        }
        // The page answers from its address (`?answer=1`), the same way the call card on the web does.
        Intent open = new Intent(this, HomeActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(origin + path + "?answer=1"))
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (keyguard != null && keyguard.isKeyguardLocked()) {
            // Unlocked first: the call opens the whole app, which is not shown over the lock screen.
            keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    startActivity(open);
                    finish();
                }

                @Override
                public void onDismissCancelled() {
                    finish();
                }

                @Override
                public void onDismissError() {
                    finish();
                }
            });
            return;
        }
        startActivity(open);
        finish();
    }

    @Override
    protected void onDestroy() {
        if (shown.get() == this) shown = new WeakReference<>(null);
        super.onDestroy();
    }
}
