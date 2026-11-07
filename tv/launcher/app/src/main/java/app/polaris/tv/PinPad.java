package app.polaris.tv;

import android.animation.ObjectAnimator;
import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.security.GeneralSecurityException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The PIN pad over "Who's watching?" and Manage profiles: the profile, a dot per digit, and a 3x4 keypad the
 * d-pad moves across. The remote's number keys type directly, and a check submits as soon as the PIN's length is
 * typed. Hashing runs on a background thread. The typed PIN only ever lives in this dialog and is never logged.
 */
final class PinPad {
    /** One thread for every hash, so two tries never race over the same record. */
    private static final ExecutorService HASHING = Executors.newSingleThreadExecutor();
    /** The pad on screen, so a second press of OK does not stack another one over it. Main thread. */
    private static Dialog showing;

    private enum Step { CHECK, NEW, CONFIRM }

    private final Activity activity;
    private final Profiles.Profile profile;
    private final Runnable onDone;
    private final Dialog dialog;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final float density;
    private final LinearLayout dots;
    private final TextView prompt;
    private final TextView message;
    private final StringBuilder typed = new StringBuilder();
    private Step step;
    private String first;
    private boolean busy;
    /** The message line holds the lockout countdown. */
    private boolean countingDown;
    private final Runnable tick = this::showLockout;

    private PinPad(Activity activity, Profiles.Profile profile, Step step, Runnable onDone) {
        this.activity = activity;
        this.profile = profile;
        this.step = step;
        this.onDone = onDone;
        density = activity.getResources().getDisplayMetrics().density;

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xF70B0F17);

        TextView avatar = ProfilePicker.avatar(activity, profile, (int) (72 * density));
        LinearLayout.LayoutParams avatarLp = new LinearLayout.LayoutParams((int) (72 * density), (int) (72 * density));
        root.addView(avatar, avatarLp);
        TextView name = text(activity, ProfilePicker.displayName(activity, profile), 24);
        root.addView(name, wrap(12));
        prompt = text(activity, "", 16);
        prompt.setTextColor(0xCCFFFFFF);
        root.addView(prompt, wrap(6));

        dots = new LinearLayout(activity);
        dots.setOrientation(LinearLayout.HORIZONTAL);
        dots.setGravity(Gravity.CENTER);
        dots.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
        root.addView(dots, wrap(22));

        message = text(activity, "", 15);
        message.setTextColor(0xFFFCA5A5);
        message.setMaxWidth((int) (420 * density));
        message.setMinLines(2);
        root.addView(message, wrap(14));

        LinearLayout keypad = new LinearLayout(activity);
        keypad.setOrientation(LinearLayout.VERTICAL);
        keypad.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);   // a keypad reads the same in every language
        String[][] keys = {{"1", "2", "3"}, {"4", "5", "6"}, {"7", "8", "9"}, {"<", "0", "OK"}};
        View one = null;
        for (String[] rowKeys : keys) {
            LinearLayout row = new LinearLayout(activity);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (String key : rowKeys) {
                TextView button = key(activity, key);
                if (one == null) one = button;
                row.addView(button);
            }
            keypad.addView(row);
        }
        root.addView(keypad, wrap(8));

        if (step == Step.CHECK) {
            TextView forgot = text(activity, activity.getString(R.string.pin_forgot), 15);
            forgot.setTextColor(0xCCFFFFFF);
            focusable(forgot);
            int pad = (int) (10 * density);
            forgot.setPadding(pad * 2, pad, pad * 2, pad);
            forgot.setOnClickListener(v -> {
                main.removeCallbacks(tick);
                countingDown = false;
                message.setTextColor(0xCCFFFFFF);
                message.setText(R.string.pin_forgot_explain);
            });
            root.addView(forgot, wrap(16));
        }

        dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
        dialog.setContentView(root);
        dialog.setCancelable(true);
        dialog.setCanceledOnTouchOutside(false);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        }
        dialog.setOnKeyListener((d, keyCode, event) -> {
            int digit = digitOf(keyCode);
            if (digit < 0 && keyCode != KeyEvent.KEYCODE_DEL) return false;
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                if (digit >= 0) type((char) ('0' + digit));
                else erase();
            }
            return true;
        });
        dialog.setOnDismissListener(d -> {
            main.removeCallbacks(tick);
            typed.setLength(0);
        });
        dialog.show();
        showing = dialog;
        enter(step);
        if (one != null) one.requestFocus();
    }

    /** Asks for the profile's PIN; {@code onUnlocked} runs once it is right. Back closes the pad. */
    static void check(Activity activity, Profiles.Profile profile, Runnable onUnlocked) {
        if (padShowing()) return;
        if (Profiles.pin(activity, profile.id) == null) {
            onUnlocked.run();
            return;
        }
        new PinPad(activity, profile, Step.CHECK, onUnlocked);
    }

    /** Asks for a new PIN twice and keeps it; {@code onSaved} runs after. */
    static void create(Activity activity, Profiles.Profile profile, Runnable onSaved) {
        if (padShowing()) return;
        new PinPad(activity, profile, Step.NEW, onSaved);
    }

    private static boolean padShowing() {
        if (showing != null) {
            Activity owner = showing.getOwnerActivity();
            if (!showing.isShowing() || owner == null || owner.isDestroyed()) showing = null;
        }
        return showing != null;
    }

    static int digitOf(int keyCode) {
        if (keyCode >= KeyEvent.KEYCODE_0 && keyCode <= KeyEvent.KEYCODE_9) return keyCode - KeyEvent.KEYCODE_0;
        if (keyCode >= KeyEvent.KEYCODE_NUMPAD_0 && keyCode <= KeyEvent.KEYCODE_NUMPAD_9) {
            return keyCode - KeyEvent.KEYCODE_NUMPAD_0;
        }
        return -1;
    }

    private void enter(Step next) {
        step = next;
        typed.setLength(0);
        prompt.setText(next == Step.CHECK ? R.string.pin_enter : next == Step.NEW ? R.string.pin_new
                : R.string.pin_confirm);
        drawDots();
        if (next == Step.CHECK) showLockout();
    }

    /** The PIN's length when it is known (a check, a confirmation), else the most a new one can have. */
    private int length() {
        if (step == Step.CONFIRM) return first.length();
        if (step == Step.CHECK) {
            PinHash.Record record = Profiles.pin(activity, profile.id);
            return record == null ? PinHash.MIN_LENGTH : record.len;
        }
        return PinHash.MAX_LENGTH;
    }

    private void drawDots() {
        dots.removeAllViews();
        int size = (int) (16 * density);
        int count = length();
        for (int i = 0; i < count; i++) {
            View dot = new View(activity);
            GradientDrawable shape = new GradientDrawable();
            shape.setShape(GradientDrawable.OVAL);
            shape.setStroke((int) (2 * density), Color.WHITE);
            shape.setColor(i < typed.length() ? Color.WHITE : Color.TRANSPARENT);
            dot.setBackground(shape);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(size, size);
            int gap = (int) (8 * density);
            lp.setMargins(gap, 0, gap, 0);
            dots.addView(dot, lp);
        }
    }

    private void type(char digit) {
        if (busy) return;
        if (lockoutMs() > 0) {
            if (!countingDown) showLockout();
            return;
        }
        if (typed.length() >= length()) return;
        typed.append(digit);
        if (!countingDown) message.setText("");
        drawDots();
        if (step != Step.NEW && typed.length() == length()) submit();
        else if (step == Step.NEW && typed.length() == PinHash.MAX_LENGTH) submit();
    }

    private void erase() {
        if (busy || typed.length() == 0) return;
        typed.setLength(typed.length() - 1);
        drawDots();
    }

    private void submit() {
        if (busy) return;
        String pin = typed.toString();
        if (step == Step.NEW) {
            if (!PinHash.valid(pin)) {
                error(activity.getString(R.string.pin_too_short));
                return;
            }
            first = pin;
            enter(Step.CONFIRM);
            return;
        }
        if (step == Step.CONFIRM) {
            if (!pin.equals(first)) {
                first = null;
                enter(Step.NEW);
                error(activity.getString(R.string.pin_mismatch));
                return;
            }
            save(pin);
            return;
        }
        verify(pin);
    }

    private void verify(String pin) {
        PinHash.Record record = Profiles.pin(activity, profile.id);
        if (record == null) {
            finish();
            return;
        }
        busy = true;
        HASHING.execute(() -> {
            Boolean right;
            try {
                right = PinHash.matches(record, pin, PinHash.keystore());
            } catch (GeneralSecurityException | RuntimeException e) {
                right = null;
            }
            Boolean outcome = right;
            main.post(() -> verified(outcome));
        });
    }

    /**
     * {@code right} null: the Keystore could not check it, which is not counted as a miss. A miss is counted even
     * when the pad was closed while it was being checked, so Back cannot be used to try PINs for free.
     */
    private void verified(Boolean right) {
        busy = false;
        boolean showing = dialog.isShowing();
        PinHash.Record record = Profiles.pin(activity, profile.id);
        if (record == null) {
            if (showing) finish();
            return;
        }
        PinLockout lockout = lockout();
        if (right == null) {
            if (showing) error(activity.getString(R.string.pin_check_failed));
            return;
        }
        if (right) {
            Profiles.savePin(activity, profile.id, record.withLockout(lockout.success(record.lockout)));
            if (showing) finish();
            return;
        }
        Profiles.savePin(activity, profile.id, record.withLockout(lockout.fail(lockout.observe(record.lockout))));
        if (!showing) return;
        error(activity.getString(R.string.pin_wrong));
        showLockout();
    }

    private void save(String pin) {
        busy = true;
        prompt.setText(R.string.pin_saving);
        int known = Profiles.pinIterations(activity);
        HASHING.execute(() -> {
            PinHash.Record record;
            int iters = known;
            try {
                if (iters <= 0) iters = PinHash.tune();
                record = PinHash.create(pin, iters, PinHash.newSalt(), PinHash.keystore());
            } catch (GeneralSecurityException | RuntimeException e) {
                record = null;
            }
            PinHash.Record made = record;
            int tuned = iters;
            main.post(() -> {
                busy = false;
                if (!dialog.isShowing()) return;   // closed while saving: nothing is kept
                if (made == null) {
                    first = null;
                    enter(Step.NEW);
                    error(activity.getString(R.string.pin_save_failed));
                    return;
                }
                if (known <= 0) Profiles.setPinIterations(activity, tuned);
                Profiles.savePin(activity, profile.id, made);
                finish();
            });
        });
    }

    private void finish() {
        dialog.dismiss();
        onDone.run();
    }

    private void error(String text) {
        typed.setLength(0);
        drawDots();
        message.setTextColor(0xFFFCA5A5);
        message.setText(text);
        countingDown = false;
        ObjectAnimator.ofFloat(dots, "translationX", 0, 24, -24, 16, -16, 8, -8, 0).setDuration(360).start();
    }

    private PinLockout lockout() {
        int boot = Settings.Global.getInt(activity.getContentResolver(), Settings.Global.BOOT_COUNT,
                PinLockout.NO_BOOT);
        return new PinLockout(System::currentTimeMillis, SystemClock::elapsedRealtime, boot);
    }

    private long lockoutMs() {
        if (step != Step.CHECK) return 0L;
        PinHash.Record record = Profiles.pin(activity, profile.id);
        if (record == null) return 0L;
        PinLockout lockout = lockout();
        PinLockout.State observed = lockout.observe(record.lockout);
        if (observed != record.lockout) Profiles.savePin(activity, profile.id, record.withLockout(observed));
        return lockout.remainingMs(observed);
    }

    private String lockoutText() {
        long seconds = (lockoutMs() + 999L) / 1000L;
        return activity.getString(R.string.pin_locked_out,
                String.format(Locale.getDefault(), "%d:%02d", seconds / 60L, seconds % 60L));
    }

    /** The countdown while a wait is owed, every second until the pad opens again. */
    private void showLockout() {
        main.removeCallbacks(tick);
        if (!dialog.isShowing()) return;
        if (lockoutMs() <= 0) {
            if (countingDown) message.setText("");
            countingDown = false;
            return;
        }
        countingDown = true;
        message.setTextColor(0xFFFCA5A5);
        message.setText(lockoutText());
        main.postDelayed(tick, 1000L);
    }

    private TextView key(Context ctx, String key) {
        TextView button = text(ctx, key.equals("<") ? ctx.getString(R.string.pin_delete) : key, 22);
        focusable(button);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams((int) (96 * density), (int) (60 * density));
        int gap = (int) (5 * density);
        lp.setMargins(gap, gap, gap, gap);
        button.setLayoutParams(lp);
        if (key.equals("<")) {
            button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
            button.setOnClickListener(v -> erase());
        } else if (key.equals("OK")) {
            button.setText(android.R.string.ok);
            button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
            button.setOnClickListener(v -> {
                if (!busy && step == Step.NEW) submit();   // a check and a confirmation submit by themselves
            });
        } else {
            button.setOnClickListener(v -> type(key.charAt(0)));
        }
        return button;
    }

    private void focusable(TextView view) {
        view.setFocusable(true);
        view.setClickable(true);
        GradientDrawable lit = new GradientDrawable();
        lit.setCornerRadius(14 * density);
        lit.setColor(0x40FFFFFF);
        lit.setStroke((int) (2 * density), Color.WHITE);
        GradientDrawable rest = new GradientDrawable();
        rest.setCornerRadius(14 * density);
        rest.setColor(0x1AFFFFFF);
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_focused}, lit);
        states.addState(new int[]{}, rest);
        view.setBackground(states);
    }

    private static TextView text(Context ctx, String value, int sp) {
        TextView view = new TextView(ctx);
        view.setText(value);
        view.setTextColor(Color.WHITE);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private LinearLayout.LayoutParams wrap(int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = (int) (topDp * density);
        return lp;
    }
}
