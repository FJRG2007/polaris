package app.polaris.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Whether a newer build of this app has been published, asked at most twice a day. A copy installed from its GitHub
 * release has nothing else to tell the phone; a newer one is offered with a button that downloads it, and the system
 * installer puts it over this one because both carry the same key.
 *
 * A copy installed from a store is that store's to update, and both Google Play and F-Droid forbid an app updating
 * itself any other way, so there the check never runs.
 */
final class UpdateCheck {
    /** Every Android tag, and only those: the repository publishes many products, and a list of its releases
     *  would push an Android one off its first page within days. */
    static final String TAGS = "https://api.github.com/repos/FJRG2007/polaris/git/matching-refs/tags/android-v";
    static final String DOWNLOAD = "https://github.com/FJRG2007/polaris/releases/download/";
    static final String TAG_PREFIX = "android-v";
    static final String ASSET = "polaris-android.apk";
    /** After a check that reached the releases, the next one waits this long. */
    static final long EVERY_MS = 3L * 60 * 60 * 1000;
    /** After one that could not (offline, rate-limited), the next return to the app tries again after this. */
    static final long RETRY_MS = 10L * 60 * 1000;
    private static final java.util.concurrent.atomic.AtomicBoolean RUNNING =
            new java.util.concurrent.atomic.AtomicBoolean();
    private static final int MAX_BYTES = 512 * 1024;

    /** Stores that keep the app updated themselves: Google Play, F-Droid and its common clients, Aurora, Obtainium. */
    private static final java.util.Set<String> STORES = new java.util.HashSet<>(java.util.Arrays.asList(
            "com.android.vending",
            "org.fdroid.fdroid",
            "org.fdroid.basic",
            "com.looker.droidify",
            "com.machiav3lli.fdroid",
            "com.aurora.store",
            "dev.imranr.obtainium",
            "dev.imranr.obtainium.fdroid"));

    private UpdateCheck() {
    }

    /** Whether the package that installed this app updates it itself. Null (a file opened by hand, adb) is not. */
    static boolean storeInstalled(String installer) {
        return installer != null && STORES.contains(installer);
    }

    @SuppressWarnings("deprecation")
    private static String installer(Context context) {
        try {
            PackageManager packages = context.getPackageManager();
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                return packages.getInstallSourceInfo(context.getPackageName()).getInstallingPackageName();
            }
            return packages.getInstallerPackageName(context.getPackageName());
        } catch (Exception unknown) {
            return null;
        }
    }

    /** The newest published build: its version and download address, or null when none is newer than `current`. */
    static String[] newest(String refsJson, String current) {
        JSONArray refs;
        try {
            refs = new JSONArray(refsJson);
        } catch (Exception malformed) {
            return null;
        }
        String best = null;
        for (int i = 0; i < refs.length(); i++) {
            JSONObject ref = refs.optJSONObject(i);
            String name = ref == null ? "" : ref.optString("ref", "");
            if (!name.startsWith("refs/tags/" + TAG_PREFIX)) continue;
            String version = name.substring(("refs/tags/" + TAG_PREFIX).length());
            if (!version.matches("\\d+(\\.\\d+){0,3}")) continue;
            if (compare(version, current) > 0 && (best == null || compare(version, best) > 0)) best = version;
        }
        return best == null ? null : new String[] {best, DOWNLOAD + TAG_PREFIX + best + "/" + ASSET};
    }

    /** Compares dotted versions numerically: 0.1.10 is after 0.1.9. Anything unreadable counts as 0. */
    static int compare(String a, String b) {
        String[] left = a.split("\\.");
        String[] right = b.split("\\.");
        for (int i = 0; i < Math.max(left.length, right.length); i++) {
            int x = i < left.length ? number(left[i]) : 0;
            int y = i < right.length ? number(right[i]) : 0;
            if (x != y) return Integer.compare(x, y);
        }
        return 0;
    }

    private static int number(String part) {
        try {
            return Integer.parseInt(part.trim());
        } catch (NumberFormatException notNumber) {
            return 0;
        }
    }

    /** Whether a store keeps this install updated, so a check by hand has nothing to offer. */
    static boolean byStore(Context context) {
        return storeInstalled(installer(context));
    }

    /**
     * A check asked for by hand, from Settings: offers the newer version as the daily check does, or says on `status`
     * that this one is the newest, or that the check could not reach the releases.
     */
    static void checkNow(Activity activity, android.widget.TextView status) {
        status.setText(R.string.settings_update_checking);
        new Thread(() -> {
            String[] found;
            try {
                found = newest(fetch(), BuildConfig.VERSION_NAME);
            } catch (Exception offline) {
                activity.runOnUiThread(() -> status.setText(R.string.settings_update_failed));
                return;
            }
            activity.runOnUiThread(() -> {
                if (found == null) {
                    status.setText(R.string.settings_update_latest);
                    return;
                }
                status.setText(activity.getString(R.string.update_title, found[0]));
                if (SelfUpdate.supported(activity)) SelfUpdate.found(activity, found[0], found[1], true, status);
                else offerBrowser(activity, found[0], found[1]);
            });
        }, "update-check-now").start();
    }

    /**
     * Whether the automatic check is due: a check that reached the releases counts for `EVERY_MS`, one that failed only
     * holds the next try back `RETRY_MS`, so a phone that was offline at the last attempt is not left a day behind.
     */
    static boolean due(long now, long checkedAt, long failedAt) {
        // A clock moved backwards makes every stored time "in the future": treat that as never checked.
        if (checkedAt > now || failedAt > now) return true;
        return now - checkedAt >= EVERY_MS && now - failedAt >= RETRY_MS;
    }

    static void maybeRun(Activity activity) {
        if (storeInstalled(installer(activity))) return;
        SharedPreferences prefs = activity.getSharedPreferences("update", Context.MODE_PRIVATE);
        if (!due(System.currentTimeMillis(), prefs.getLong("checkedAt", 0), prefs.getLong("failedAt", 0))) return;
        if (!RUNNING.compareAndSet(false, true)) return;
        new Thread(() -> {
            try {
                String[] found;
                try {
                    found = newest(fetch(), BuildConfig.VERSION_NAME);
                } catch (Exception offline) {
                    prefs.edit().putLong("failedAt", System.currentTimeMillis()).apply();
                    return;
                }
                prefs.edit().putLong("checkedAt", System.currentTimeMillis()).remove("failedAt").apply();
                if (found == null) return;
                activity.runOnUiThread(() -> {
                    if (SelfUpdate.supported(activity)) SelfUpdate.found(activity, found[0], found[1], false, null);
                    else offerBrowser(activity, found[0], found[1]);
                });
            } finally {
                RUNNING.set(false);
            }
        }, "update-check").start();
    }

    /** The newer version offered as a download in the browser, for a build or a phone that cannot install it itself. */
    static void offerBrowser(Activity activity, String version, String url) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.update_title, version))
                .setMessage(R.string.update_message)
                .setPositiveButton(R.string.update_download, (dialog, which) -> openDownload(activity, url))
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    static void openDownload(Activity activity, String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException none) {
            // No browser to download with: nothing to do but leave it.
        }
    }

    private static String fetch() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(TAGS).openConnection();
        try {
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            if (connection.getResponseCode() != 200) throw new IllegalStateException("status " + connection.getResponseCode());
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (out.size() + read > MAX_BYTES) throw new IllegalStateException("too large");
                    out.write(buffer, 0, read);
                }
                return out.toString(StandardCharsets.UTF_8.name());
            }
        } finally {
            connection.disconnect();
        }
    }
}
