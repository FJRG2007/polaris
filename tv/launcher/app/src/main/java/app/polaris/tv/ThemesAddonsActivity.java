package app.polaris.tv;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Settings > Themes & add-ons: every theme and add-on in this build's release, filterable by kind, with the focused
 * item's screenshot, what it needs (Android version, internet, permissions) and one button: Apply theme, which
 * unpacks it into the launcher's own storage and starts Home again, or Install add-on, which opens Android's own
 * install confirm. No terminal and no computer.
 */
public class ThemesAddonsActivity extends Activity {

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean busy = new AtomicBoolean();
    /** Bumped on every focus change, so a slow screenshot never lands on the item focused after it. */
    private final AtomicInteger shown = new AtomicInteger();
    private List<Catalog.Item> items = new ArrayList<>();
    private String kind;
    private LinearLayout list;
    private TextView status;
    private ImageView shot;
    private TextView details;
    private TextView action;
    private Catalog.Item current;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setBackgroundColor(0xFF0B0F1A);
        int pad = dp(32);
        root.setPadding(pad, pad, pad, pad);

        LinearLayout left = new LinearLayout(this);
        left.setOrientation(LinearLayout.VERTICAL);
        TextView title = text(getString(R.string.catalog_title), 26);
        left.addView(title);
        LinearLayout filters = new LinearLayout(this);
        filters.setOrientation(LinearLayout.HORIZONTAL);
        filters.addView(filter(R.string.catalog_all, null));
        filters.addView(filter(R.string.catalog_themes, Catalog.THEME));
        filters.addView(filter(R.string.catalog_addons, Catalog.ADDON));
        left.addView(filters);
        status = text(getString(R.string.catalog_loading), 16);
        left.addView(status);
        ScrollView scroll = new ScrollView(this);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(list);
        left.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        root.addView(left, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));

        LinearLayout right = new LinearLayout(this);
        right.setOrientation(LinearLayout.VERTICAL);
        right.setPadding(dp(32), 0, 0, 0);
        shot = new ImageView(this);
        shot.setScaleType(ImageView.ScaleType.FIT_CENTER);
        shot.setAdjustViewBounds(true);
        right.addView(shot, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(300)));
        details = text("", 16);
        right.addView(details);
        action = row("");
        action.setVisibility(View.GONE);
        action.setOnClickListener(v -> act());
        right.addView(action);
        root.addView(right, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
        setContentView(root);
        load();
    }

    private void load() {
        status.setText(R.string.catalog_loading);
        new Thread(() -> {
            List<Catalog.Item> loaded;
            try {
                loaded = Catalog.parse(CatalogInstall.fetchCatalog(getApplicationContext()));
            } catch (CatalogInstall.Failed failed) {
                loaded = null;
            }
            List<Catalog.Item> result = loaded;
            main.post(() -> {
                if (isFinishing()) return;
                if (result == null) {
                    status.setText(R.string.catalog_unreachable);
                    TextView retry = row(getString(R.string.catalog_retry));
                    retry.setOnClickListener(v -> {
                        list.removeAllViews();
                        load();
                    });
                    list.removeAllViews();
                    list.addView(retry);
                    retry.requestFocus();
                    return;
                }
                items = result;
                show();
            });
        }, "polaris-catalog").start();
    }

    private void show() {
        list.removeAllViews();
        List<Catalog.Item> visible = Catalog.ofKind(items, kind);
        status.setText(visible.isEmpty() ? getString(R.string.catalog_empty) : "");
        status.setVisibility(visible.isEmpty() ? View.VISIBLE : View.GONE);
        for (Catalog.Item item : visible) {
            TextView entry = row(item.name);
            entry.setOnFocusChangeListener((v, focused) -> {
                if (focused) select(item);
            });
            entry.setOnClickListener(v -> {
                select(item);
                action.requestFocus();
            });
            list.addView(entry);
        }
        if (!visible.isEmpty()) list.getChildAt(0).requestFocus();
    }

    private void select(Catalog.Item item) {
        current = item;
        StringBuilder text = new StringBuilder(item.description);
        text.append("\n\n").append(getString(item.network ? R.string.catalog_network : R.string.catalog_offline));
        if (!item.permissions.isEmpty()) {
            List<String> names = new ArrayList<>();
            for (String p : item.permissions) names.add(p.substring(p.lastIndexOf('.') + 1));
            text.append("\n").append(getString(R.string.catalog_permissions, TextUtils.join(", ", names)));
        }
        boolean runs = item.runsOn(Build.VERSION.SDK_INT);
        if (!runs) text.append("\n").append(getString(R.string.catalog_too_old));
        details.setText(text);
        action.setVisibility(runs ? View.VISIBLE : View.GONE);
        action.setText(item.isTheme() ? getString(R.string.catalog_apply)
                : getString(CatalogInstall.installed(this, item.packageName)
                        ? R.string.catalog_reinstall : R.string.catalog_install));
        shot.setImageDrawable(null);
        int ticket = shown.incrementAndGet();
        new Thread(() -> {
            byte[] bytes = CatalogInstall.fetchScreenshot(getApplicationContext(), item);
            Bitmap bitmap = bytes == null ? null : BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            main.post(() -> {
                if (ticket == shown.get() && !isFinishing()) shot.setImageBitmap(bitmap);
            });
        }, "polaris-catalog-shot").start();
    }

    private void act() {
        Catalog.Item item = current;
        if (item == null) return;
        if (!busy.compareAndSet(false, true)) {
            details.setText(R.string.catalog_busy);
            return;
        }
        details.setText(getString(R.string.catalog_downloading, item.name));
        new Thread(() -> {
            CatalogInstall.Failure failure = null;
            try {
                if (item.isTheme()) CatalogInstall.applyTheme(this, item);
                else CatalogInstall.installAddon(this, item);
            } catch (CatalogInstall.Failed failed) {
                failure = failed.failure;
            } finally {
                busy.set(false);
            }
            CatalogInstall.Failure outcome = failure;
            main.post(() -> {
                if (outcome != null) {
                    details.setText(getString(R.string.catalog_failed, item.name, why(outcome)));
                } else if (item.isTheme()) {
                    details.setText(getString(R.string.catalog_applied, item.name));
                    CatalogInstall.restartHome(this);
                    finish();
                } else {
                    details.setText(R.string.catalog_confirm);
                }
            });
        }, "polaris-catalog-install").start();
    }

    private String why(CatalogInstall.Failure failure) {
        switch (failure) {
            case CHECKSUM: return getString(R.string.catalog_why_checksum);
            case REFUSED: return getString(R.string.catalog_why_refused);
            case NOT_STARTED: return getString(R.string.update_why_not_started);
            default: return getString(R.string.catalog_why_unreachable);
        }
    }

    private TextView filter(int label, String filterKind) {
        TextView view = row(getString(label));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(52));
        params.setMarginEnd(dp(10));
        view.setLayoutParams(params);
        view.setOnClickListener(v -> {
            kind = filterKind;
            show();
        });
        return view;
    }

    private TextView row(String label) {
        TextView view = text(label, 18);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(dp(18), 0, dp(18), 0);
        view.setBackgroundResource(R.drawable.settings_choice_bg);
        view.setFocusable(true);
        view.setClickable(true);
        view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        params.topMargin = dp(10);
        view.setLayoutParams(params);
        return view;
    }

    private TextView text(String value, int sp) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(0xFFFFFFFF);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
