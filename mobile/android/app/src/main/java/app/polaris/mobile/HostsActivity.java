package app.polaris.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;

/**
 * The app's own screen: every Polaris this phone opens, to open one or add another, then notifications, language,
 * Vault autofill and the browser, and the version with a check for a newer one. Editing, removing, importing and
 * exporting hosts is the page's Settings > This app > Hosts (`PageHosts`), as on the desktop app. Reached from the
 * launcher shortcut, a scanned list of hosts, and the page that shows when a Polaris cannot be reached.
 */
public final class HostsActivity extends Activity {
    private LinearLayout list;
    private LinearLayout appRows;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_hosts);
        SystemInsets.pad(findViewById(R.id.root));
        list = findViewById(R.id.hosts);
        appRows = findViewById(R.id.app_rows);
        findViewById(R.id.add_host).setOnClickListener(view -> startActivity(new Intent(this, ServerActivity.class)));

        ((TextView) findViewById(R.id.version)).setText(getString(R.string.settings_version, BuildConfig.VERSION_NAME));
        TextView status = findViewById(R.id.update_status);
        Button check = findViewById(R.id.check_updates);
        if (UpdateCheck.byStore(this)) {
            check.setVisibility(View.GONE);
            status.setText(R.string.settings_update_store);
        } else {
            check.setOnClickListener(view -> UpdateCheck.checkNow(this, status));
        }
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
        drawAppRows();
    }

    private void draw() {
        list.removeAllViews();
        ServerStore.Host active = ServerStore.active(this);
        for (ServerStore.Host host : ServerStore.all(this)) {
            list.addView(row(host, active != null && active.id.equals(host.id)));
        }
    }

    private View row(ServerStore.Host host, boolean current) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackgroundResource(R.drawable.field);
        row.setPaddingRelative(dp(16), dp(12), dp(16), dp(12));
        row.setLayoutParams(spaced());

        LinearLayout names = new LinearLayout(this);
        names.setOrientation(LinearLayout.VERTICAL);
        names.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView name = text(host.label(), 16, R.color.foreground);
        name.setTypeface(getResources().getFont(R.font.plex_sans_semibold));
        names.addView(name);
        names.addView(text(current ? getString(R.string.hosts_current, host.origin) : host.origin, 13, R.color.muted));
        row.addView(names);

        row.setClickable(true);
        row.setFocusable(true);
        row.setContentDescription(getString(R.string.hosts_open, host.label()));
        row.setOnClickListener(view -> open(host));
        return row;
    }

    /** Notifications, language, Vault autofill and the browser: one row each, the system's own screen behind most. */
    private void drawAppRows() {
        appRows.removeAllViews();
        ServerStore.Host active = ServerStore.active(this);
        for (String action : actions(this)) {
            switch (action) {
                case "notifications":
                    appRows.addView(setting(R.string.settings_notifications,
                            getString(R.string.settings_notifications_hint), view -> act(this, action)));
                    break;
                case "language":
                    appRows.addView(setting(R.string.settings_language, getString(R.string.settings_language_hint),
                            view -> act(this, action)));
                    break;
                case "vault":
                    appRows.addView(setting(R.string.vault_title, getString(R.string.vault_hint),
                            view -> act(this, action)));
                    break;
                case "browser":
                    appRows.addView(setting(R.string.settings_browser, active.origin, view -> act(this, action)));
                    break;
                default:
                    break;
            }
        }
    }

    /**
     * The rows this phone has, in order, by the names the page's Settings > This app uses for them
     * (`APP_PHONE_ACTIONS` in the dashboard): one list for both screens, so they never disagree.
     */
    static java.util.List<String> actions(Activity activity) {
        java.util.List<String> names = new ArrayList<>();
        names.add("notifications");
        // Android 13 and later choose a language per app; before that the app follows the phone's.
        if (android.os.Build.VERSION.SDK_INT >= 33) names.add("language");
        names.add("vault");
        if (ServerStore.active(activity) != null) names.add("browser");
        return names;
    }

    /** Opens the screen a row names. Anything not in `actions` is refused, so a page cannot name another. */
    static void act(Activity activity, String action) {
        if (action == null || !actions(activity).contains(action)) return;
        switch (action) {
            case "notifications":
                system(activity, new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName()));
                return;
            case "language":
                system(activity, new Intent(Settings.ACTION_APP_LOCALE_SETTINGS)
                        .setData(Uri.fromParts("package", activity.getPackageName(), null)));
                return;
            case "vault":
                activity.startActivity(new Intent(activity, VaultActivity.class));
                return;
            case "browser":
                ServerStore.Host active = ServerStore.active(activity);
                if (active == null) return;
                try {
                    activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(active.origin))
                            .addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException none) {
                    Toast.makeText(activity, R.string.link_unsupported, Toast.LENGTH_SHORT).show();
                }
                return;
            default:
                break;
        }
    }

    private View setting(int title, String hint, View.OnClickListener click) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setBackgroundResource(R.drawable.field);
        row.setPadding(dp(16), dp(12), dp(16), dp(12));
        row.setLayoutParams(spaced());
        TextView name = text(getString(title), 16, R.color.foreground);
        row.addView(name);
        TextView detail = text(hint, 13, R.color.muted);
        detail.setSingleLine(false);
        row.addView(detail);
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(click);
        return row;
    }

    /** One of the system's screens for this app, or its details page where that one is missing. */
    private static void system(Activity activity, Intent intent) {
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException missing) {
            activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.fromParts("package", activity.getPackageName(), null)));
        }
    }

    private void open(ServerStore.Host host) {
        ServerStore.Host active = ServerStore.active(this);
        if (active != null && active.id.equals(host.id)) {
            // Already the one open: back to it as it was.
            startActivity(new Intent(this, HomeActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP));
        } else {
            ServerStore.select(this, host.id);
            HomeActivity.reopen(this);
        }
        finish();
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

    private LinearLayout.LayoutParams spaced() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(8);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
