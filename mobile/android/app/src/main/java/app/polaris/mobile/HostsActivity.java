package app.polaris.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Every Polaris this phone opens: tap one to open it, rename or remove it, or add another. Each is signed in on its
 * own, so switching never signs anybody out.
 */
public final class HostsActivity extends Activity {
    private static final int MAX_NAME = 60;
    private LinearLayout list;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_hosts);
        SystemInsets.pad(findViewById(R.id.root));
        list = findViewById(R.id.hosts);
        Button add = findViewById(R.id.add_host);
        add.setOnClickListener(view -> startActivity(new Intent(this, ServerActivity.class)));
        findViewById(R.id.vault_autofill).setOnClickListener(view -> startActivity(new Intent(this, VaultActivity.class)));
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (ServerStore.all(this).isEmpty()) {
            startActivity(new Intent(this, ServerActivity.class));
            finish();
            return;
        }
        draw();
    }

    private void draw() {
        list.removeAllViews();
        ServerStore.Host active = ServerStore.active(this);
        for (ServerStore.Host host : ServerStore.all(this)) list.addView(row(host, active != null && active.id.equals(host.id)));
    }

    private View row(ServerStore.Host host, boolean current) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setBackgroundResource(R.drawable.field);
        int pad = dp(16);
        row.setPadding(pad, pad, pad, dp(8));
        LinearLayout.LayoutParams spaced = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        spaced.topMargin = dp(8);
        row.setLayoutParams(spaced);

        TextView name = text(host.label(), 16, R.color.foreground);
        name.setTypeface(getResources().getFont(R.font.plex_sans_semibold));
        row.addView(name);
        TextView address = text(current ? getString(R.string.hosts_current, host.origin) : host.origin, 13, R.color.muted);
        row.addView(address);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);
        actions.addView(action(R.string.hosts_rename, view -> rename(host)));
        actions.addView(action(R.string.hosts_remove, view -> confirmRemove(host, current)));
        row.addView(actions);

        row.setClickable(true);
        row.setFocusable(true);
        row.setContentDescription(getString(R.string.hosts_open, host.label()));
        row.setOnClickListener(view -> open(host));
        return row;
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(getColor(color));
        view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END);
        return view;
    }

    private Button action(int label, View.OnClickListener click) {
        Button button = new Button(this, null, 0, R.style.Widget_Polaris_Button_Ghost);
        button.setText(label);
        button.setOnClickListener(click);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMarginStart(dp(8));
        button.setLayoutParams(params);
        return button;
    }

    private void open(ServerStore.Host host) {
        ServerStore.Host active = ServerStore.active(this);
        if (active != null && active.id.equals(host.id)) {
            // Already the one open: back to it as it was.
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP));
        } else {
            ServerStore.select(this, host.id);
            MainActivity.reopen(this);
        }
        finish();
    }

    private void rename(ServerStore.Host host) {
        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        field.setFilters(new InputFilter[] {new InputFilter.LengthFilter(MAX_NAME)});
        field.setSingleLine(true);
        field.setText(host.name != null ? host.name : "");
        field.setHint(host.label());
        field.setSelection(field.getText().length());
        FrameLayout box = new FrameLayout(this);
        int pad = dp(24);
        box.setPadding(pad, dp(8), pad, 0);
        box.addView(field);
        new AlertDialog.Builder(this)
                .setTitle(R.string.hosts_rename_title)
                .setView(box)
                .setPositiveButton(R.string.hosts_save, (dialog, which) -> {
                    String name = field.getText().toString().trim();
                    if (name.equals(host.name != null ? host.name : "")) return;
                    ServerStore.rename(this, host.id, name);
                    draw();
                })
                .setNegativeButton(R.string.hosts_cancel, null)
                .show();
    }

    private void confirmRemove(ServerStore.Host host, boolean current) {
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.hosts_remove_title, host.label()))
                .setMessage(R.string.hosts_remove_message)
                .setPositiveButton(R.string.hosts_remove, (dialog, which) -> remove(host, current))
                .setNegativeButton(R.string.hosts_cancel, null)
                .show();
    }

    private void remove(ServerStore.Host host, boolean current) {
        HostProfiles.clear(host);
        ServerStore.remove(this, host.id);
        if (!current) {
            draw();
            return;
        }
        if (ServerStore.active(this) != null) {
            MainActivity.reopen(this);
        } else {
            stopService(new Intent(this, NoticeService.class));
            startActivity(new Intent(this, ServerActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        }
        finish();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
