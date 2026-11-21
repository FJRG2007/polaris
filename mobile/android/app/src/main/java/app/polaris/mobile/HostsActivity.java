package app.polaris.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Menu;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The app's own settings, what the desktop app keeps in its Settings window: every Polaris this phone opens - open,
 * edit, reorder, remove, add, import from another device and export to one - then notifications, language, Vault
 * autofill and the browser, and the version with a check for a newer one. Reached from Settings in the account menu of
 * any Polaris page, the launcher shortcut, and the page that shows when a Polaris cannot be reached.
 */
public final class HostsActivity extends Activity {
    private static final int MAX_NAME = HostList.NAME_MAX;
    private static final int OPEN_FILE = 1;
    private static final int MAX_FILE_BYTES = 64 * 1024;
    private static final int MENU_EDIT = 1;
    private static final int MENU_UP = 2;
    private static final int MENU_DOWN = 3;
    private static final int MENU_REMOVE = 4;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private LinearLayout list;
    private LinearLayout appRows;
    private AlertDialog importing;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_hosts);
        SystemInsets.pad(findViewById(R.id.root));
        list = findViewById(R.id.hosts);
        appRows = findViewById(R.id.app_rows);
        findViewById(R.id.add_host).setOnClickListener(view -> startActivity(new Intent(this, ServerActivity.class)));
        findViewById(R.id.import_hosts).setOnClickListener(view -> askImport());
        findViewById(R.id.export_hosts).setOnClickListener(view -> export());

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

    @Override
    protected void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }

    private void draw() {
        list.removeAllViews();
        ServerStore.Host active = ServerStore.active(this);
        List<ServerStore.Host> hosts = ServerStore.all(this);
        for (int i = 0; i < hosts.size(); i++) {
            ServerStore.Host host = hosts.get(i);
            list.addView(row(host, active != null && active.id.equals(host.id), i, hosts.size()));
        }
        findViewById(R.id.export_hosts).setEnabled(!hosts.isEmpty());
    }

    private View row(ServerStore.Host host, boolean current, int index, int count) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackgroundResource(R.drawable.field);
        row.setPaddingRelative(dp(16), dp(12), dp(4), dp(12));
        row.setLayoutParams(spaced());

        LinearLayout names = new LinearLayout(this);
        names.setOrientation(LinearLayout.VERTICAL);
        names.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView name = text(host.label(), 16, R.color.foreground);
        name.setTypeface(getResources().getFont(R.font.plex_sans_semibold));
        names.addView(name);
        names.addView(text(current ? getString(R.string.hosts_current, host.origin) : host.origin, 13, R.color.muted));
        row.addView(names);

        ImageButton more = new ImageButton(this);
        more.setImageResource(android.R.drawable.ic_menu_more);
        more.setColorFilter(getColor(R.color.muted));
        more.setBackgroundResource(R.drawable.button_ghost);
        more.setContentDescription(getString(R.string.hosts_options, host.label()));
        more.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        more.setOnClickListener(view -> options(view, host, current, index, count));
        row.addView(more);

        row.setClickable(true);
        row.setFocusable(true);
        row.setContentDescription(getString(R.string.hosts_open, host.label()));
        row.setOnClickListener(view -> open(host));
        row.setOnLongClickListener(view -> {
            options(more, host, current, index, count);
            return true;
        });
        return row;
    }

    private void options(View anchor, ServerStore.Host host, boolean current, int index, int count) {
        PopupMenu menu = new PopupMenu(this, anchor);
        Menu items = menu.getMenu();
        items.add(Menu.NONE, MENU_EDIT, 0, R.string.hosts_edit);
        if (index > 0) items.add(Menu.NONE, MENU_UP, 1, R.string.hosts_move_up);
        if (index < count - 1) items.add(Menu.NONE, MENU_DOWN, 2, R.string.hosts_move_down);
        items.add(Menu.NONE, MENU_REMOVE, 3, R.string.hosts_remove);
        menu.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case MENU_EDIT:
                    edit(host, current);
                    return true;
                case MENU_UP:
                    ServerStore.move(this, host.id, -1);
                    draw();
                    return true;
                case MENU_DOWN:
                    ServerStore.move(this, host.id, 1);
                    draw();
                    return true;
                case MENU_REMOVE:
                    confirmRemove(host, current);
                    return true;
                default:
                    return false;
            }
        });
        menu.show();
    }

    /** Notifications, language, Vault autofill and the browser: one row each, the system's own screen behind most. */
    private void drawAppRows() {
        appRows.removeAllViews();
        appRows.addView(setting(R.string.settings_notifications, getString(R.string.settings_notifications_hint), view ->
                system(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()))));
        // Android 13 and later choose a language per app; before that the app follows the phone's.
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            appRows.addView(setting(R.string.settings_language, getString(R.string.settings_language_hint), view ->
                    system(new Intent(Settings.ACTION_APP_LOCALE_SETTINGS)
                            .setData(Uri.fromParts("package", getPackageName(), null)))));
        }
        appRows.addView(setting(R.string.vault_title, getString(R.string.vault_hint), view ->
                startActivity(new Intent(this, VaultActivity.class))));
        ServerStore.Host active = ServerStore.active(this);
        if (active != null) {
            appRows.addView(setting(R.string.settings_browser, active.origin, view -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(active.origin))
                            .addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException none) {
                    Toast.makeText(this, R.string.link_unsupported, Toast.LENGTH_SHORT).show();
                }
            }));
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
    private void system(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException missing) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.fromParts("package", getPackageName(), null)));
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

    /** Address and name, as the desktop app edits a host. A new address is checked to be a Polaris before it is kept. */
    private void edit(ServerStore.Host host, boolean current) {
        EditText address = field(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, ServerAddress.MAX_LENGTH);
        address.setText(host.origin);
        EditText name = field(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS, MAX_NAME);
        name.setText(host.name != null ? host.name : "");
        TextView problem = text("", 13, R.color.danger);
        problem.setSingleLine(false);
        problem.setVisibility(View.GONE);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(8), dp(24), 0);
        box.addView(label(R.string.hosts_address));
        box.addView(address);
        box.addView(label(R.string.hosts_name));
        box.addView(name);
        TextView nameHint = text(getString(R.string.hosts_name_hint), 13, R.color.muted);
        nameHint.setSingleLine(false);
        box.addView(nameHint);
        box.addView(problem);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(getString(R.string.hosts_edit_title, host.label()))
                .setView(box)
                .setPositiveButton(R.string.hosts_save, null)
                .setNegativeButton(R.string.hosts_cancel, null)
                .create();
        dialog.setOnShowListener(shown -> {
            Button save = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            Runnable validate = () -> save.setEnabled(ServerAddress.origin(address.getText().toString()) != null);
            address.addTextChangedListener(new TextWatcher() {
                @Override
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {
                }

                @Override
                public void onTextChanged(CharSequence s, int start, int before, int count) {
                }

                @Override
                public void afterTextChanged(Editable s) {
                    problem.setVisibility(View.GONE);
                    validate.run();
                }
            });
            validate.run();
            save.setOnClickListener(view -> {
                String origin = ServerAddress.origin(address.getText().toString());
                if (origin == null) return;
                String typedName = name.getText().toString().replaceAll("\\s+", " ").trim();
                String oldName = host.name != null ? host.name : "";
                if (origin.equals(host.origin)) {
                    if (!typedName.equals(oldName)) ServerStore.rename(this, host.id, typedName);
                    dialog.dismiss();
                    draw();
                    return;
                }
                for (ServerStore.Host other : ServerStore.all(this)) {
                    if (!other.id.equals(host.id) && other.origin.equals(origin)) {
                        say(problem, getString(R.string.hosts_taken));
                        return;
                    }
                }
                save.setEnabled(false);
                say(problem, getString(R.string.hosts_checking));
                worker.execute(() -> {
                    ServerProbe.Verdict verdict = ServerProbe.probe(origin);
                    main.post(() -> {
                        if (isFinishing() || !dialog.isShowing()) return;
                        save.setEnabled(true);
                        if (verdict != ServerProbe.Verdict.POLARIS) {
                            say(problem, getString(ServerActivity.reason(verdict)));
                            return;
                        }
                        if (!ServerStore.changeAddress(this, host.id, origin)) {
                            say(problem, getString(R.string.hosts_taken));
                            return;
                        }
                        if (!typedName.equals(oldName)) ServerStore.rename(this, host.id, typedName);
                        dialog.dismiss();
                        // The window open now is on the old address: reopen it on the new one.
                        if (current) {
                            HomeActivity.reopen(this);
                            finish();
                        } else {
                            draw();
                        }
                    });
                });
            });
        });
        dialog.show();
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
            HomeActivity.reopen(this);
        } else {
            stopService(new Intent(this, NoticeService.class));
            startActivity(new Intent(this, ServerActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        }
        finish();
    }

    /** The code the desktop app's Import takes, through the share sheet: a chat to yourself, mail, the clipboard. */
    private void export() {
        List<HostList.Entry> entries = new ArrayList<>();
        for (ServerStore.Host host : ServerStore.all(this)) entries.add(new HostList.Entry(host.origin, host.name));
        if (entries.isEmpty()) return;
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_SUBJECT, getString(R.string.hosts_export_subject))
                .putExtra(Intent.EXTRA_TEXT, HostList.encode(entries));
        startActivity(Intent.createChooser(send, getString(R.string.hosts_export_title)));
    }

    /** A code pasted from another device's Export, or the file it saved. A QR is read by the camera app instead. */
    private void askImport() {
        EditText code = field(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, 64 * 1024);
        code.setSingleLine(false);
        code.setMinLines(3);
        code.setHint("polaris-hosts:...");
        TextView hint = text(getString(R.string.hosts_import_hint), 13, R.color.muted);
        hint.setSingleLine(false);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(8), dp(24), 0);
        box.addView(hint);
        box.addView(code);
        importing = new AlertDialog.Builder(this)
                .setTitle(R.string.hosts_import_title)
                .setView(box)
                .setPositiveButton(R.string.hosts_import, null)
                .setNeutralButton(R.string.hosts_import_file, null)
                .setNegativeButton(R.string.hosts_cancel, null)
                .create();
        importing.setOnShowListener(shown -> {
            Button take = importing.getButton(AlertDialog.BUTTON_POSITIVE);
            take.setEnabled(false);
            code.addTextChangedListener(new TextWatcher() {
                @Override
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {
                }

                @Override
                public void onTextChanged(CharSequence s, int start, int before, int count) {
                }

                @Override
                public void afterTextChanged(Editable s) {
                    take.setEnabled(s.toString().trim().length() > 0);
                }
            });
            take.setOnClickListener(view -> {
                if (take(code.getText().toString())) importing.dismiss();
            });
            importing.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> {
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*");
                try {
                    startActivityForResult(pick, OPEN_FILE);
                } catch (ActivityNotFoundException none) {
                    Toast.makeText(this, R.string.link_unsupported, Toast.LENGTH_SHORT).show();
                }
            });
        });
        importing.show();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != OPEN_FILE || result != RESULT_OK || data == null || data.getData() == null) return;
        Uri file = data.getData();
        worker.execute(() -> {
            String text = readCapped(file);
            main.post(() -> {
                if (isFinishing()) return;
                if (take(text) && importing != null) importing.dismiss();
            });
        });
    }

    private String readCapped(Uri file) {
        try (InputStream in = getContentResolver().openInputStream(file)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (out.size() + read > MAX_FILE_BYTES) return null;
                out.write(buffer, 0, read);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception unreadable) {
            return null;
        }
    }

    /** Takes in the hosts a code or file holds, the same way a scanned QR is; false when it holds none. */
    private boolean take(String raw) {
        List<HostList.Entry> hosts = HostList.read(raw);
        if (hosts == null) {
            Toast.makeText(this, R.string.link_hosts_invalid, Toast.LENGTH_LONG).show();
            return false;
        }
        int[] counts = ServerStore.importHosts(this, hosts);
        String said = counts[0] > 0
                ? getResources().getQuantityString(R.plurals.link_hosts_added, counts[0], counts[0])
                : getString(R.string.link_hosts_none_new);
        if (counts[2] > 0) said += " " + getResources().getQuantityString(R.plurals.link_hosts_skipped, counts[2], counts[2]);
        Toast.makeText(this, said, Toast.LENGTH_LONG).show();
        draw();
        return true;
    }

    private void say(TextView view, String message) {
        view.setText(message);
        view.setVisibility(View.VISIBLE);
    }

    private EditText field(int type, int max) {
        EditText field = new EditText(this);
        field.setInputType(type);
        field.setFilters(new InputFilter[] {new InputFilter.LengthFilter(max)});
        field.setSingleLine(true);
        return field;
    }

    private TextView label(int value) {
        TextView view = text(getString(value), 14, R.color.foreground);
        view.setPadding(0, dp(12), 0, dp(4));
        return view;
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
