package app.polaris.tv;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * The Android side of the Themes & add-ons screen: reads the catalog (from the instance this TV is connected to,
 * else from this build's GitHub release), downloads a file
 * (checked against the size and SHA-256 the catalog lists), applies a theme into {@link Config#dir} through
 * {@link ThemeUnpack}, and hands an add-on to PackageInstaller through {@link SelfUpdateRun#commit}, never silently:
 * Android always asks first. Everything here blocks, so callers run it on their own thread.
 */
final class CatalogInstall {

    static final String EXTRA_ADDON = "app.polaris.tv.extra.CATALOG_ADDON";
    private static final int MAX_HOPS = 4;

    /** Why a download or an apply did not finish, in the words the screen shows. */
    enum Failure { UNREACHABLE, CHECKSUM, REFUSED, NOT_STARTED }

    static final class Failed extends Exception {
        final Failure failure;

        Failed(Failure failure) {
            super(failure.name());
            this.failure = failure;
        }
    }

    private CatalogInstall() {}

    /** The catalog: the instance's copy of the newest release's, else the one of this launcher's own release. */
    static String fetchCatalog(Context context) throws Failed {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        fetch(context, Catalog.FILE_NAME, body, Catalog.MAX_CATALOG_BYTES);
        return new String(body.toByteArray(), StandardCharsets.UTF_8);
    }

    /** A screenshot's bytes, or null when it could not be read. */
    static byte[] fetchScreenshot(Context context, Catalog.Item item) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        try {
            fetch(context, item.screenshot, body, Catalog.MAX_SCREENSHOT_BYTES);
            return body.toByteArray();
        } catch (Failed failed) {
            return null;
        }
    }

    /**
     * One catalog file into {@code out}: from the instance when this TV is connected to one, from the GitHub release
     * when it is not or cannot answer. A file the instance cut short is not mixed with GitHub's: the caller's buffer
     * is reset first, and the size and checksum are checked by the caller either way.
     */
    private static void fetch(Context context, String name, OutputStream out, long max) throws Failed {
        if (fromInstance(context, name, out, max)) return;
        if (out instanceof ByteArrayOutputStream) ((ByteArrayOutputStream) out).reset();
        else if (out instanceof FileOutputStream) {
            try {
                ((FileOutputStream) out).getChannel().truncate(0).position(0);
            } catch (IOException unwritable) {
                throw new Failed(Failure.UNREACHABLE);
            }
        }
        String url = Catalog.url(BuildConfig.VERSION_NAME, name);
        if (url == null) throw new Failed(Failure.UNREACHABLE);
        get(url, out, max);
    }

    /** True when the instance served the whole file; false (nothing to rely on in {@code out}) otherwise. */
    private static boolean fromInstance(Context context, String name, OutputStream out, long max) {
        String path = Catalog.instancePath(name);
        if (path == null || !PolarisLink.connected(context)) return false;
        PolarisLink link = PolarisLink.load(context);
        if (link == null) return false;
        try {
            SelfUpdate.Download reply = link.updateNet().download(path, 0, null);
            try (InputStream in = reply.body) {
                if (reply.status != 200 || in == null) return false;
                byte[] chunk = new byte[64 * 1024];
                long total = 0;
                for (int read; (read = in.read(chunk)) != -1; ) {
                    total += read;
                    if (total > max) return false;
                    out.write(chunk, 0, read);
                }
                return true;
            }
        } catch (IOException | RuntimeException unreachable) {
            return false;
        }
    }

    /** Downloads the item's file into the app's cache and returns it once its size and checksum match. */
    static File download(Context context, Catalog.Item item) throws Failed {
        File dir = new File(context.getCacheDir(), "catalog");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File target = new File(dir, item.file);
        try (OutputStream out = new FileOutputStream(target)) {
            fetch(context, item.file, out, item.size);
        } catch (IOException | Failed failed) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            if (failed instanceof Failed) throw (Failed) failed;
            throw new Failed(Failure.UNREACHABLE);
        }
        if (target.length() != item.size || !item.sha256.equals(sha256(target))) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            throw new Failed(Failure.CHECKSUM);
        }
        return target;
    }

    /** Downloads and applies a theme; Home picks it up when it starts again. */
    static void applyTheme(Context context, Catalog.Item item) throws Failed {
        File dir = Config.dir(context);
        if (dir == null) throw new Failed(Failure.NOT_STARTED);
        File zip = download(context, item);
        try (InputStream in = new FileInputStream(zip)) {
            ThemeUnpack.apply(in, dir, "catalog:" + item.id + ":" + item.sha256.substring(0, 12), ThemeUnpack.MAX_BYTES);
        } catch (ThemeUnpack.Refused refused) {
            throw new Failed(Failure.REFUSED);
        } catch (IOException failed) {
            throw new Failed(Failure.NOT_STARTED);
        } finally {
            //noinspection ResultOfMethodCallIgnored
            zip.delete();
        }
    }

    /** Downloads an add-on and opens the system install; the result arrives at {@link UpdateStatusReceiver}. */
    static void installAddon(Context context, Catalog.Item item) throws Failed {
        File apk = download(context, item);
        Intent status = new Intent(context, UpdateStatusReceiver.class).setAction(SelfUpdateRun.ACTION_STATUS)
                .putExtra(EXTRA_ADDON, item.name);
        try {
            SelfUpdateRun.commit(context, SelfUpdateRun.partial(apk), item.size, item.packageName, false, status);
        } catch (IOException | RuntimeException refused) {
            throw new Failed(Failure.NOT_STARTED);
        } finally {
            // The session holds its own copy once written.
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
        }
    }

    /** The installer's word on an add-on: the system confirm, then installed or why not. */
    @SuppressWarnings("deprecation")
    static void onStatus(Context app, String name, int status, Intent intent) {
        if (status == SelfUpdate.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                try {
                    app.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    Toast.makeText(app, R.string.catalog_confirm, Toast.LENGTH_LONG).show();
                    return;
                } catch (ActivityNotFoundException | SecurityException blocked) {
                    status = SelfUpdate.STATUS_FAILURE_BLOCKED;
                }
            }
        }
        if (status == SelfUpdate.STATUS_SUCCESS) {
            Toast.makeText(app, app.getString(R.string.catalog_addon_installed, name), Toast.LENGTH_LONG).show();
            return;
        }
        String why = SelfUpdateRun.why(app, SelfUpdate.failureFor(status == SelfUpdate.STATUS_PENDING_USER_ACTION
                ? SelfUpdate.STATUS_FAILURE : status));
        Toast.makeText(app, app.getString(R.string.catalog_failed, name, why), Toast.LENGTH_LONG).show();
    }

    static boolean installed(Context context, String packageName) {
        try {
            context.getPackageManager().getPackageInfo(packageName, 0);
            return true;
        } catch (android.content.pm.PackageManager.NameNotFoundException absent) {
            return false;
        }
    }

    /** GET with redirects followed by hand, each hop only to GitHub over HTTPS, stopping past {@code max} bytes. */
    private static void get(String address, OutputStream out, long max) throws Failed {
        String url = address;
        for (int hop = 0; hop <= MAX_HOPS; hop++) {
            if (!Catalog.allowedHost(url)) throw new Failed(Failure.UNREACHABLE);
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(PolarisFailover.TIMEOUT_MS);
                connection.setReadTimeout(SelfUpdateRun.TIMEOUT_MS);
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setRequestProperty("User-Agent", "polaris-tv/" + BuildConfig.VERSION_NAME);
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String next = connection.getHeaderField("Location");
                    if (next == null) throw new Failed(Failure.UNREACHABLE);
                    url = new URL(new URL(url), next).toString();
                    continue;
                }
                if (status != 200) throw new Failed(Failure.UNREACHABLE);
                try (InputStream in = connection.getInputStream()) {
                    byte[] chunk = new byte[64 * 1024];
                    long total = 0;
                    for (int read; (read = in.read(chunk)) != -1; ) {
                        total += read;
                        if (total > max) throw new Failed(Failure.CHECKSUM);
                        out.write(chunk, 0, read);
                    }
                }
                return;
            } catch (IOException unreachable) {
                throw new Failed(Failure.UNREACHABLE);
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        throw new Failed(Failure.UNREACHABLE);
    }

    static String sha256(File file) {
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] chunk = new byte[64 * 1024];
            for (int read; (read = in.read(chunk)) != -1; ) digest.update(chunk, 0, read);
            StringBuilder hex = new StringBuilder(64);
            for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return hex.toString();
        } catch (IOException | NoSuchAlgorithmException unreadable) {
            return null;
        }
    }

    /** Starts Home again so it reads the theme just applied. */
    static void restartHome(Context context) {
        context.startActivity(new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
    }
}
