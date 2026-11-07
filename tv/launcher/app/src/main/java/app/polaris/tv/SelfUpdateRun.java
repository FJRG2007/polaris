package app.polaris.tv;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Runs {@link SelfUpdate} on this TV: the instance over the TV key, the APK in the app's own files, and the
 * system's PackageInstaller. Everything here blocks, so it runs on its own thread.
 *
 * When the install asks nobody (Android 12+), from the PackageInstaller.SessionParams#setRequireUserAction
 * docs (https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int))
 * and AOSP PackageInstallerSession#computeUserActionRequirement
 * (https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/pm/PackageInstallerSession.java):
 * an installer holding REQUEST_INSTALL_PACKAGES skips the prompt only when it asks for USER_ACTION_NOT_REQUIRED,
 * declares UPDATE_PACKAGES_WITHOUT_USER_ACTION, the new build targets a recent enough SDK (29 on Android 12, 30 on
 * 13, 31 on 14, 33 on 15, 34 on 16, 35 after), and the installer is the update owner, the installer of record,
 * or *updating itself* (isSelfUpdate: the target package's uid is the caller's). Polaris TV updating itself meets
 * the last one whatever installed it, so the install over ADB does not need to name it as installer of record.
 * The exception is update ownership: when another installer claimed it at first install, AOSP returns the
 * update-owner reminder before the self-update test, and the system confirm shows. The ADB shell never claims
 * it. Android 8 to 11, a build too old for the target SDK rule, or a TV whose vendor changed this: the system
 * shows its confirm, the launcher reports waiting-confirmation and Polaris says "Confirm on the TV".
 */
final class SelfUpdateRun {

    private static final String PREFS = "self_update";
    private static final String SEEN = "seen_request";
    private static final String CHECKED_AT = "checked_at";
    private static final String NEWEST = "newest";
    private static final String NOTICED = "noticed";
    private static final long DAY_MS = 24 * 60 * 60_000L;
    static final int TIMEOUT_MS = 30_000;
    static final String EXTRA_REQUEST = "app.polaris.tv.extra.UPDATE_REQUEST";
    static final String ACTION_STATUS = "app.polaris.tv.action.UPDATE_STATUS";

    private static final AtomicBoolean running = new AtomicBoolean();

    private SelfUpdateRun() {}

    interface Listener {
        /** Called on the main thread. */
        void done(SelfUpdate.Result result);
    }

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The newest version the last check saw, or null. */
    static String newest(Context context) {
        return prefs(context).getString(NEWEST, null);
    }

    static boolean running() {
        return running.get();
    }

    /** Null when this TV is not connected to a Polaris. */
    static SelfUpdate of(Context context) {
        PolarisLink link = PolarisLink.load(context);
        if (link == null) return null;
        return new SelfUpdate(link.updateNet(), new SystemInstaller(context), Thread::sleep,
                BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE);
    }

    /** Checks only. */
    static void check(Context context, Listener listener) {
        Context app = context.getApplicationContext();
        new Thread(() -> {
            SelfUpdate update = of(app);
            SelfUpdate.Result result = update == null
                    ? new SelfUpdate.Result(SelfUpdate.Outcome.UNREACHABLE, null, null) : update.check();
            remember(app, result);
            if (result.outcome == SelfUpdate.Outcome.UP_TO_DATE) discardDownload(app);
            post(listener, result);
        }, "polaris-update-check").start();
    }

    /** Deletes the downloaded APK once it is installed or no longer newer than this build. */
    static void discardDownload(Context context) {
        partialFor(context).delete();
    }

    /** The TV's own words for why an update did not finish. */
    static String why(Context context, SelfUpdate.Failure failure) {
        if (failure == null) return context.getString(R.string.update_why_not_installed);
        switch (failure) {
            case NO_RELEASE: return context.getString(R.string.update_no_release);
            case RELEASE_MISMATCH: return context.getString(R.string.update_why_release_mismatch);
            case RELEASE_TOO_LARGE: return context.getString(R.string.update_why_release_too_large);
            case RELEASE_UNAVAILABLE: return context.getString(R.string.update_why_release_unavailable);
            case DOWNLOAD_STOPPED: return context.getString(R.string.update_why_download_stopped);
            case CHECKSUM: return context.getString(R.string.update_mismatch);
            case NOT_POLARIS_TV: return context.getString(R.string.update_why_not_polaris_tv);
            case NOT_NEWER: return context.getString(R.string.update_refused);
            case NOT_STARTED: return context.getString(R.string.update_why_not_started);
            case CANCELLED: return context.getString(R.string.update_why_cancelled);
            case BLOCKED: return context.getString(R.string.update_why_blocked);
            case CONFLICT: return context.getString(R.string.update_why_conflict);
            case STORAGE: return context.getString(R.string.update_why_storage);
            case INCOMPATIBLE: return context.getString(R.string.update_why_incompatible);
            case INVALID: return context.getString(R.string.update_why_invalid);
            case TIMEOUT: return context.getString(R.string.update_why_timeout);
            default: return context.getString(R.string.update_why_not_installed);
        }
    }

    /**
     * The whole update. {@code requestId} is the request from Polaris, or null from the TV. A second start while
     * one runs does nothing.
     */
    static boolean start(Context context, String requestId, Listener listener) {
        if (!running.compareAndSet(false, true)) return false;
        Context app = context.getApplicationContext();
        new Thread(() -> {
            SelfUpdate.Result result;
            try {
                SelfUpdate update = of(app);
                result = update == null ? new SelfUpdate.Result(SelfUpdate.Outcome.UNREACHABLE, null, null)
                        : update.update(requestId, partialFor(app));
                remember(app, result);
                // A request that reached an end (or the installer) is not started again by the next poll; one that
                // could not reach the instance is.
                if (requestId != null && result.outcome != SelfUpdate.Outcome.UNREACHABLE
                        && result.outcome != SelfUpdate.Outcome.RATE_LIMITED) {
                    prefs(app).edit().putString(SEEN, requestId).apply();
                }
            } finally {
                running.set(false);
            }
            post(listener, result);
        }, "polaris-update").start();
        return true;
    }

    /** A request from Polaris seen on the state poll: started once per id, never while another runs. */
    static void onRequest(Context context, String requestId) {
        if (requestId == null || requestId.equals(prefs(context).getString(SEEN, null))) return;
        start(context, requestId, result -> {
            if (result.outcome == SelfUpdate.Outcome.INSTALLING) {
                Toast.makeText(context.getApplicationContext(), R.string.update_installing, Toast.LENGTH_LONG).show();
            }
        });
    }

    /** Once a day, from Home: a notice when a newer build is on the Polaris. Never installs. */
    static void dailyCheck(Context context) {
        if (!PolarisLink.connected(context) || running.get()) return;
        long now = System.currentTimeMillis();
        long last = prefs(context).getLong(CHECKED_AT, 0);
        if (last != 0 && now - last < DAY_MS && now >= last) return;
        prefs(context).edit().putLong(CHECKED_AT, now).apply();
        Context app = context.getApplicationContext();
        check(app, result -> {
            if (result.outcome != SelfUpdate.Outcome.AVAILABLE) return;
            String version = result.release.versionName;
            if (version.equals(prefs(app).getString(NOTICED, null))) return;
            prefs(app).edit().putString(NOTICED, version).apply();
            Toast.makeText(app, app.getString(R.string.update_notice, version), Toast.LENGTH_LONG).show();
        });
    }

    private static void remember(Context context, SelfUpdate.Result result) {
        if (result.release != null) prefs(context).edit().putString(NEWEST, result.release.versionName).apply();
    }

    private static void post(Listener listener, SelfUpdate.Result result) {
        if (listener != null) new Handler(Looper.getMainLooper()).post(() -> listener.done(result));
    }

    /**
     * The APK on disk, one at a time. A part left by an older release is never resumed into a newer one: the
     * resume sends If-Range with the release checksum, and the instance answers a changed file whole.
     */
    private static SelfUpdate.Partial partialFor(Context context) {
        File dir = new File(context.getFilesDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new SelfUpdate.Partial() {
            private File file;

            private File file() {
                if (file == null) file = new File(dir, "polaris-tv.apk");
                return file;
            }

            @Override
            public long length() {
                return file().length();
            }

            @Override
            public OutputStream open(boolean append) throws IOException {
                return new FileOutputStream(file(), append);
            }

            @Override
            public InputStream read() throws IOException {
                return new FileInputStream(file());
            }

            @Override
            public void delete() {
                //noinspection ResultOfMethodCallIgnored
                file().delete();
            }

            @Override
            public String toString() {
                return file().getAbsolutePath();
            }
        };
    }

    /** PackageInstaller, with the status sent to {@link UpdateStatusReceiver}. */
    static final class SystemInstaller implements SelfUpdate.Installer {
        private final Context context;

        SystemInstaller(Context context) {
            this.context = context.getApplicationContext();
        }

        @Override
        public SelfUpdate.Archive read(SelfUpdate.Partial file) {
            PackageInfo info = context.getPackageManager().getPackageArchiveInfo(file.toString(), 0);
            if (info == null) return null;
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            return new SelfUpdate.Archive(info.packageName, code);
        }

        @Override
        public void install(SelfUpdate.Partial file, long size, String requestId) throws IOException {
            PackageInstaller installer = context.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params =
                    new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(SelfUpdate.PACKAGE);
            params.setSize(size);
            if (Build.VERSION.SDK_INT >= 31) {
                // See the class comment for when Android honours this; when it does not, the status is
                // STATUS_PENDING_USER_ACTION and UpdateStatusReceiver shows the system confirm.
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            }
            int id = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (InputStream in = file.read(); OutputStream out = session.openWrite("polaris-tv.apk", 0, size)) {
                    byte[] chunk = new byte[64 * 1024];
                    for (int read; (read = in.read(chunk)) != -1; ) out.write(chunk, 0, read);
                    session.fsync(out);
                }
                Intent status = new Intent(context, UpdateStatusReceiver.class).setAction(ACTION_STATUS)
                        .putExtra(EXTRA_REQUEST, requestId);
                // Mutable: the installer adds the status extras to this intent (required from Android 12).
                int flags = PendingIntent.FLAG_UPDATE_CURRENT
                        | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                session.commit(PendingIntent.getBroadcast(context, id, status, flags).getIntentSender());
            } catch (IOException | RuntimeException refused) {
                installer.abandonSession(id);
                throw refused instanceof IOException ? (IOException) refused : new IOException(refused);
            }
        }
    }

    /**
     * The update routes over HttpURLConnection, which follows the system's certificate trust. The JSON calls go
     * through the failover; the download goes to the address the last of them was answered on.
     */
    static final class Http implements SelfUpdate.Net {
        private final PolarisFailover failover;
        private final PolarisLocalCa.Scope localCa;
        private final String token;

        Http(PolarisFailover failover, PolarisLocalCa.Scope localCa, String token) {
            this.failover = failover;
            this.localCa = localCa;
            this.token = token;
        }

        private HttpURLConnection open(String method, String path) throws IOException {
            HttpURLConnection connection = (HttpURLConnection) new URL(failover.origin() + path).openConnection();
            PolarisLocalCa.apply(connection, localCa);
            connection.setConnectTimeout(PolarisFailover.TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestMethod(method);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("User-Agent", "polaris-tv/" + BuildConfig.VERSION_NAME);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            return connection;
        }

        @Override
        public SelfUpdate.Reply get(String path) throws IOException {
            return json("GET", path, null);
        }

        @Override
        public SelfUpdate.Reply post(String path, String body) throws IOException {
            return json("POST", path, body);
        }

        private SelfUpdate.Reply json(String method, String path, String body) throws IOException {
            PolarisFailover.Reply reply = failover.request(method, path, body, token);
            return new SelfUpdate.Reply(reply.status, reply.body, reply.retryAfterSeconds);
        }

        @Override
        public SelfUpdate.Download download(String path, long offset, String ifRange) throws IOException {
            HttpURLConnection connection = open("GET", path);
            try {
                connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
                if (offset > 0) {
                    connection.setRequestProperty("Range", "bytes=" + offset + "-");
                    if (ifRange != null) connection.setRequestProperty("If-Range", ifRange);
                }
                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                InputStream body = stream == null ? null : new FilterInputStream(stream) {
                    @Override
                    public void close() throws IOException {
                        try {
                            super.close();
                        } finally {
                            connection.disconnect();
                        }
                    }
                };
                if (body == null) connection.disconnect();
                return new SelfUpdate.Download(status, PolarisLink.retryAfter(connection), body);
            } catch (IOException failed) {
                connection.disconnect();
                throw failed;
            }
        }
    }
}
