package app.polaris.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The GitHub-installed app updating itself, without a browser or a file manager in between.
 *
 * A newer version is downloaded in the background, checked against the release's SHA256SUMS and against this app's
 * package and version, and handed to the system installer. On Android 12 and later an app updating itself may ask for
 * no confirmation (`setRequireUserAction`), so it is installed the moment the person leaves the app and is simply there
 * the next time they open it; the system still refuses any APK not signed with this app's key. Older Android versions,
 * or a system that wants a confirmation anyway, show its one-tap prompt the next time the app is open.
 *
 * Only in the build published on GitHub (`BuildConfig.SELF_UPDATE`): Google Play and F-Droid forbid an app installing
 * its own updates, and their builds do not even declare the permission.
 */
final class SelfUpdate {
    static final String ACTION_RESULT = "app.polaris.mobile.UPDATE_RESULT";
    private static final String SUMS = "SHA256SUMS";
    private static final long MAX_APK_BYTES = 300L * 1024 * 1024;
    private static final int MAX_SUMS_BYTES = 16 * 1024;
    private static final AtomicBoolean DOWNLOADING = new AtomicBoolean();
    /** The one-tap offer is made once per launch, so declining it does not bring it back on every return. */
    private static volatile boolean offeredThisRun;

    private SelfUpdate() {
    }

    /** Whether this build may install its own updates on this phone at all. */
    static boolean supported(Context context) {
        return BuildConfig.SELF_UPDATE && !UpdateCheck.byStore(context);
    }

    /** Whether the person has let Polaris install apps ("Install unknown apps"), which every self-update needs. */
    static boolean allowed(Context context) {
        return supported(context) && context.getPackageManager().canRequestPackageInstalls();
    }

    /** The expected digest of `asset` in a SHA256SUMS file (`<hex>  <name>` per line), lower case, or null. */
    static String digestFor(String sums, String asset) {
        if (sums == null) return null;
        for (String line : sums.split("\n")) {
            String[] parts = line.trim().split("\\s+");
            if (parts.length != 2) continue;
            String name = parts[1].startsWith("*") ? parts[1].substring(1) : parts[1];
            if (name.equals(asset) && parts[0].matches("[0-9a-fA-F]{64}")) return parts[0].toLowerCase(Locale.ROOT);
        }
        return null;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("self-update", Context.MODE_PRIVATE);
    }

    private static File dir(Context context) {
        return new File(context.getNoBackupFilesDir(), "update");
    }

    /** The downloaded, verified version waiting to be installed, or null. Leftovers of an installed one are removed. */
    static String ready(Context context) {
        String version = prefs(context).getString("ready", null);
        File apk = version == null ? null : new File(dir(context), "polaris-" + version + ".apk");
        if (version != null && UpdateCheck.compare(version, BuildConfig.VERSION_NAME) > 0 && apk.isFile()) return version;
        clear(context);
        return null;
    }

    private static void clear(Context context) {
        prefs(context).edit().remove("ready").remove("confirm").apply();
        File[] files = dir(context).listFiles();
        if (files != null) for (File file : files) file.delete();
    }

    /**
     * A newer version was found: without the permission the person is asked for it once (with the browser download
     * as the other way); with it the version is downloaded now and installed by `installWhenLeaving`, or straight
     * away when `now` - a check asked for by hand.
     */
    static void found(Activity activity, String version, String url, boolean now, android.widget.TextView status) {
        if (!allowed(activity)) {
            askPermission(activity, version, url);
            return;
        }
        if (version.equals(ready(activity))) {
            if (now) install(activity, version, true);
            else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) offerInstall(activity, version);
            return;
        }
        if (!DOWNLOADING.compareAndSet(false, true)) return;
        if (status != null) status.setText(activity.getString(R.string.update_downloading, version));
        Context app = activity.getApplicationContext();
        new Thread(() -> {
            boolean ok;
            try {
                ok = download(app, version, url);
            } finally {
                DOWNLOADING.set(false);
            }
            activity.runOnUiThread(() -> {
                if (!ok) {
                    if (status != null) status.setText(R.string.update_download_failed);
                    else UpdateCheck.offerBrowser(activity, version, url);
                    return;
                }
                if (status != null) status.setText(activity.getString(R.string.update_ready, version));
                if (now) install(activity, version, true);
                // Android 12+ installs it unasked when the person leaves the app; older versions always confirm.
                else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) offerInstall(activity, version);
            });
        }, "update-download").start();
    }

    /** The app went to the background: a version waiting is installed now, with no prompt, where Android allows it. */
    static void installWhenLeaving(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !allowed(activity)) return;
        String version = ready(activity);
        if (version == null || prefs(activity).getBoolean("confirm", false)) return;
        // Copying the APK into the session is tens of megabytes: never on the main thread.
        new Thread(() -> install(activity, version, false), "update-install").start();
    }

    /** The app is open again: a version the system wanted confirmed is offered with one tap. */
    static void offerPending(Activity activity) {
        if (offeredThisRun) return;
        String version = ready(activity);
        if (version == null || !prefs(activity).getBoolean("confirm", false)) return;
        offeredThisRun = true;
        offerInstall(activity, version);
    }

    /** A silent install that failed is not retried on every exit from the app: it becomes the one-tap offer. */
    static void failed(Context context) {
        prefs(context).edit().putBoolean("confirm", true).apply();
    }

    /** The installer answered that it needs the person: remembered, and shown at once if the app is in front. */
    static void needsConfirmation(Context context, Intent confirm) {
        prefs(context).edit().putBoolean("confirm", true).apply();
        if (confirm != null && NoticeService.pageVisible) {
            try {
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException | SecurityException blocked) {
                // Shown as the one-tap offer the next time the app opens instead.
            }
        }
    }

    private static void askPermission(Activity activity, String version, String url) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.update_title, version))
                .setMessage(R.string.update_allow_message)
                .setPositiveButton(R.string.update_allow, (dialog, which) -> {
                    try {
                        activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + activity.getPackageName())));
                    } catch (ActivityNotFoundException none) {
                        UpdateCheck.openDownload(activity, url);
                    }
                })
                .setNeutralButton(R.string.update_download, (dialog, which) -> UpdateCheck.openDownload(activity, url))
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    private static void offerInstall(Activity activity, String version) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.update_title, version))
                .setMessage(R.string.update_install_message)
                .setPositiveButton(R.string.update_install, (dialog, which) -> install(activity, version, true))
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    private static boolean download(Context context, String version, String url) {
        File folder = dir(context);
        File[] old = folder.listFiles();
        if (old != null) for (File file : old) file.delete();
        if (!folder.isDirectory() && !folder.mkdirs()) return false;
        File part = new File(folder, "download.part");
        File apk = new File(folder, "polaris-" + version + ".apk");
        try {
            String base = url.substring(0, url.lastIndexOf('/') + 1);
            String expected = digestFor(new String(fetch(base + SUMS, MAX_SUMS_BYTES), StandardCharsets.UTF_8),
                    UpdateCheck.ASSET);
            if (expected == null) return false;
            String actual = fetchTo(url, part);
            if (!expected.equals(actual) || !matchesThisApp(context, part, version)) {
                part.delete();
                return false;
            }
            if (!part.renameTo(apk)) return false;
            prefs(context).edit().putString("ready", version).remove("confirm").apply();
            return true;
        } catch (Exception failed) {
            part.delete();
            return false;
        }
    }

    /** The file is this app, at the version the release says, and newer than the one running. */
    @SuppressWarnings("deprecation")
    private static boolean matchesThisApp(Context context, File apk, String version) {
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
        if (info == null || !context.getPackageName().equals(info.packageName)) return false;
        long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
        return version.equals(info.versionName) && code > BuildConfig.VERSION_CODE;
    }

    private static void install(Activity activity, String version, boolean foreground) {
        File apk = new File(dir(activity), "polaris-" + version + ".apk");
        if (!apk.isFile()) {
            clear(activity);
            return;
        }
        PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(activity.getPackageName());
        params.setSize(apk.length());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int id = -1;
        try {
            id = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (InputStream in = new FileInputStream(apk);
                        OutputStream out = session.openWrite("polaris.apk", 0, apk.length())) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                    session.fsync(out);
                }
                Intent result = new Intent(ACTION_RESULT).setPackage(activity.getPackageName())
                        .putExtra("foreground", foreground);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT
                        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                session.commit(PendingIntent.getBroadcast(activity, id, result, flags).getIntentSender());
            }
        } catch (Exception failed) {
            if (id != -1) {
                try {
                    installer.abandonSession(id);
                } catch (Exception ignored) {
                    // Already gone.
                }
            }
            if (foreground) {
                UpdateCheck.offerBrowser(activity, version,
                        UpdateCheck.DOWNLOAD + UpdateCheck.TAG_PREFIX + version + "/" + UpdateCheck.ASSET);
            } else {
                failed(activity);
            }
        }
    }

    private static HttpURLConnection open(String address) throws Exception {
        if (!address.startsWith("https://")) throw new IllegalArgumentException("not https");
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        if (connection.getResponseCode() != 200) {
            connection.disconnect();
            throw new IllegalStateException("status " + connection.getResponseCode());
        }
        // A redirect may only land on HTTPS (GitHub sends release assets to its own storage host).
        if (!"https".equals(connection.getURL().getProtocol())) {
            connection.disconnect();
            throw new IllegalStateException("redirected off https");
        }
        return connection;
    }

    private static byte[] fetch(String address, int max) throws Exception {
        HttpURLConnection connection = open(address);
        try (InputStream in = connection.getInputStream()) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (out.size() + read > max) throw new IllegalStateException("too large");
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    /** Downloads to `target` and answers its SHA-256 in lower-case hex. */
    private static String fetchTo(String address, File target) throws Exception {
        HttpURLConnection connection = open(address);
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > MAX_APK_BYTES) throw new IllegalStateException("too large");
                sha.update(buffer, 0, read);
                out.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : sha.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }
}
