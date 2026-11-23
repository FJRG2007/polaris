package app.polaris.mobile;

import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.TypedValue;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Approving "Is this you?": what is signing in and from where, the three numbers to pick from - one of them is on the
 * sign-in screen - and then the phone's own fingerprint, face or screen lock before the answer is sent. A request from
 * a Polaris that predates number matching carries no numbers and is approved with one button, still behind the lock.
 * Not exported: reached only from the sign-in notification.
 */
public final class SignInConfirmActivity extends VaultAuthActivity {
    private static final String EXTRA_ID = "approvalId";
    private static final String EXTRA_ORIGIN = "origin";
    private static final String EXTRA_TAG = "tag";
    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_BODY = "body";
    private static final String EXTRA_CHOICES = "choices";
    private static final String EXTRA_EXPIRES = "expiresAt";

    static Intent intent(Context context, String origin, String id, String tag, String title, String body,
            int[] choices, long expiresAt) {
        return new Intent(context, SignInConfirmActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_ORIGIN, origin)
                .putExtra(EXTRA_TAG, tag)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_BODY, body)
                .putExtra(EXTRA_CHOICES, choices)
                .putExtra(EXTRA_EXPIRES, expiresAt);
    }

    private AlertDialog dialog;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String id = getIntent().getStringExtra(EXTRA_ID);
        String origin = getIntent().getStringExtra(EXTRA_ORIGIN);
        String tag = getIntent().getStringExtra(EXTRA_TAG);
        int[] choices = getIntent().getIntArrayExtra(EXTRA_CHOICES);
        boolean live = getIntent().getLongExtra(EXTRA_EXPIRES, 0) > System.currentTimeMillis();
        if (id == null || !id.matches("[0-9a-f-]{36}") || tag == null || !SignInAnswer.known(this, origin)) {
            finish();
            return;
        }
        if (!live) {
            Toast.makeText(this, R.string.sign_in_expired, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        body.setPadding(pad, dp(8), pad, 0);
        String said = getIntent().getStringExtra(EXTRA_BODY);
        if (said != null && !said.isEmpty()) body.addView(text(said));
        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(getIntent().getStringExtra(EXTRA_TITLE))
                .setView(body)
                .setNegativeButton(R.string.sign_in_deny, (d, w) -> answer(origin, id, tag, "deny", null))
                .setOnCancelListener(d -> finish());
        if (choices != null && choices.length == 3) {
            TextView hint = text(getString(R.string.sign_in_pick));
            hint.setPadding(0, dp(16), 0, dp(8));
            body.addView(hint);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (int choice : choices) {
                if (choice < 10 || choice > 99) {
                    finish();
                    return;
                }
                Button pick = new Button(this);
                pick.setText(String.valueOf(choice));
                pick.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
                pick.setOnClickListener(view -> approve(origin, id, tag, choice));
                row.addView(pick, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
            }
            body.addView(row);
        } else {
            builder.setPositiveButton(R.string.sign_in_approve, null);
        }
        dialog = builder.create();
        dialog.setOnShowListener(shown -> {
            Button approve = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            if (approve != null) approve.setOnClickListener(view -> approve(origin, id, tag, null));
        });
        dialog.show();
    }

    /** The lock first: fingerprint, face or the screen lock. A phone with no lock at all cannot approve. */
    private void approve(String origin, String id, String tag, Integer number) {
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (keyguard == null || !keyguard.isDeviceSecure()) {
            Toast.makeText(this, R.string.sign_in_needs_lock, Toast.LENGTH_LONG).show();
            return;
        }
        // Refused or cancelled: the choices stay up, to try again or deny.
        authenticate(() -> answer(origin, id, tag, "approve", number), () -> { });
    }

    private void answer(String origin, String id, String tag, String decision, Integer number) {
        SignInAnswer.send(this, origin, id, decision, number, tag, null);
        if (dialog != null) dialog.dismiss();
        finish();
    }

    @Override
    String promptTitle() {
        return getString(R.string.sign_in_confirm_title);
    }

    @Override
    String promptSubtitle() {
        return getString(R.string.sign_in_confirm_subtitle);
    }

    private TextView text(String value) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        return view;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics()));
    }
}
