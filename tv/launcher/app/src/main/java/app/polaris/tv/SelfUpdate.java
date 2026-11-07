package app.polaris.tv;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Updates Polaris TV from the Polaris it is connected to: check, download (resumed with Range), verify the
 * SHA-256, read the package, install, and report each step back when the update was asked for from Polaris.
 *
 * Pure: the network, the partial file, the installer and the clock are handed in, so every path is a unit test.
 * Never installs a build that is not newer than this one, by version name and by version code, and never one
 * whose bytes do not match the checksum the instance published. Android itself refuses a different signing key.
 */
final class SelfUpdate {

    static final String PACKAGE = "app.polaris.tv";
    static final String RELEASE_PATH = "/api/tv/update";
    static final String REPORT_PATH = "/api/tv/update/report";

    /** States the instance accepts on a report (queued is its own). */
    static final String DOWNLOADING = "downloading";
    static final String WAITING_CONFIRMATION = "waiting-confirmation";
    static final String INSTALLING = "installing";
    static final String DONE = "done";
    static final String FAILED = "failed";

    /** PackageInstaller.STATUS_* values (stable since API 21; TIMEOUT from 34). Copied so this stays pure. */
    static final int STATUS_PENDING_USER_ACTION = -1;
    static final int STATUS_SUCCESS = 0;
    static final int STATUS_FAILURE = 1;
    static final int STATUS_FAILURE_BLOCKED = 2;
    static final int STATUS_FAILURE_ABORTED = 3;
    static final int STATUS_FAILURE_INVALID = 4;
    static final int STATUS_FAILURE_CONFLICT = 5;
    static final int STATUS_FAILURE_STORAGE = 6;
    static final int STATUS_FAILURE_INCOMPATIBLE = 7;
    static final int STATUS_FAILURE_TIMEOUT = 8;

    /** Retry-After is honoured up to this long; a longer one ends this run and the next poll tries again. */
    static final long MAX_WAIT_MS = 5 * 60_000;
    /** Requests in one run, counting each rate-limited wait and each resumed download. */
    static final int MAX_ATTEMPTS = 6;
    static final int MAX_REASON = 200;

    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern VERSION = Pattern.compile("[0-9A-Za-z.+-]{1,40}");

    /** One HTTP answer. {@code retryAfterSeconds} is -1 when the header was absent or unreadable. */
    static final class Reply {
        final int status;
        final String body;
        final long retryAfterSeconds;

        Reply(int status, String body, long retryAfterSeconds) {
            this.status = status;
            this.body = body == null ? "" : body;
            this.retryAfterSeconds = retryAfterSeconds;
        }
    }

    /** A download answer. The caller closes {@code body}. */
    static final class Download {
        final int status;
        final long retryAfterSeconds;
        final InputStream body;

        Download(int status, long retryAfterSeconds, InputStream body) {
            this.status = status;
            this.retryAfterSeconds = retryAfterSeconds;
            this.body = body;
        }
    }

    /** The instance, over the TV's own key. Paths are relative to the origin in use. */
    interface Net {
        Reply get(String path) throws IOException;

        Reply post(String path, String json) throws IOException;

        /** GET with {@code Range: bytes=<offset>-} and {@code If-Range} when offset is above 0. */
        Download download(String path, long offset, String ifRange) throws IOException;
    }

    /** The APK on disk, kept between runs so a cut download resumes. */
    interface Partial {
        long length();

        /** Appends, or starts over from empty when {@code append} is false. */
        OutputStream open(boolean append) throws IOException;

        InputStream read() throws IOException;

        void delete();
    }

    /** What the package in a file says it is. Null fields when it is not an APK. */
    static final class Archive {
        final String packageName;
        final long versionCode;

        Archive(String packageName, long versionCode) {
            this.packageName = packageName;
            this.versionCode = versionCode;
        }
    }

    interface Installer {
        /** Null when the file is not a package Android can read. */
        Archive read(Partial file);

        /**
         * Hands the file to a PackageInstaller session and commits it. The result arrives later as a status
         * ({@link #onStatus}); this throws only when the session could not be opened or written.
         */
        void install(Partial file, long size, String requestId) throws IOException;
    }

    interface Clock {
        void sleep(long ms) throws InterruptedException;
    }

    /** What the newest release on the instance is. */
    static final class Release {
        final String versionName;
        /** -1 when the release does not publish one, which is the case for now. */
        final long versionCode;
        final long size;
        final String sha256;
        final String url;

        Release(String versionName, long versionCode, long size, String sha256, String url) {
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.size = size;
            this.sha256 = sha256;
            this.url = url;
        }
    }

    enum Outcome {
        /** This Polaris has no TV build released. */
        NO_RELEASE,
        /** This TV already has the newest build, or a newer one. */
        UP_TO_DATE,
        /** Newer than this one: shown as a notice, nothing installed. */
        AVAILABLE,
        /** The instance or the network did not answer; nothing changed and the next try starts again. */
        UNREACHABLE,
        /** Too many requests and a Retry-After longer than this run waits. */
        RATE_LIMITED,
        /** The bytes did not match the published checksum; the file was deleted. */
        MISMATCH,
        /** The file was not a newer Polaris TV (an older or equal version code, or another package). */
        REFUSED,
        /** The instance could not fetch or check the release. */
        FAILED,
        /** Handed to the system installer; the result arrives through {@link #onStatus}. */
        INSTALLING
    }

    /** One run's result, with the newest release when it was learned and a reason for a failure. */
    static final class Result {
        final Outcome outcome;
        final Release release;
        final String reason;

        Result(Outcome outcome, Release release, String reason) {
            this.outcome = outcome;
            this.release = release;
            this.reason = reason;
        }
    }

    /** What a report did. GONE: the instance no longer knows this request, so it is dropped here too. */
    enum Sent { SENT, SKIPPED, GONE, NOT_SENT }

    private final Net net;
    private final Installer installer;
    private final Clock clock;
    private final String installedName;
    private final long installedCode;

    SelfUpdate(Net net, Installer installer, Clock clock, String installedName, long installedCode) {
        this.net = net;
        this.installer = installer;
        this.clock = clock;
        this.installedName = installedName;
        this.installedCode = installedCode;
    }

    /**
     * Compares dotted versions: numeric segments as numbers ({@code 3.10 > 3.9}), any other as text, missing
     * ones as 0 ({@code 3.4 == 3.4.0}). The same rule the instance uses.
     */
    static int compare(String a, String b) {
        String[] left = a.split("\\.", -1);
        String[] right = b.split("\\.", -1);
        for (int i = 0; i < Math.max(left.length, right.length); i++) {
            String x = i < left.length ? left[i] : "0";
            String y = i < right.length ? right[i] : "0";
            int order = x.matches("[0-9]{1,18}") && y.matches("[0-9]{1,18}")
                    ? Long.compare(Long.parseLong(x), Long.parseLong(y)) : x.compareTo(y);
            if (order != 0) return Integer.signum(order);
        }
        return 0;
    }

    static boolean validVersion(String name) {
        return name != null && VERSION.matcher(name).matches();
    }

    /** The query the state poll carries so the instance knows this TV's version. */
    static String versionQuery(String name, long code) {
        if (!validVersion(name)) return "";
        String query = "?versionName=" + name.replace("+", "%2B");
        return code >= 1 && code <= 2_100_000_000L ? query + "&versionCode=" + code : query;
    }

    /** Asks for the newest release; with {@code install} false it only says whether there is a newer one. */
    Result check() {
        return run(null, false, null);
    }

    /** The whole flow. {@code requestId} is the Polaris request this answers, or null when started on the TV. */
    Result update(String requestId, Partial file) {
        return run(requestId, true, file);
    }

    private Result run(String requestId, boolean install, Partial file) {
        Reply reply;
        try {
            reply = call(() -> net.get(RELEASE_PATH));
        } catch (IOException | InterruptedException unreachable) {
            return new Result(Outcome.UNREACHABLE, null, null);
        }
        if (reply.status == 429) return new Result(Outcome.RATE_LIMITED, null, null);
        if (reply.status == 204) {
            return fail(requestId, Outcome.NO_RELEASE, null, "This Polaris has no TV build to install.");
        }
        if (reply.status == 502) {
            return fail(requestId, Outcome.FAILED, null, releaseFailure(reply.body));
        }
        Release release = reply.status == 200 ? readRelease(reply.body) : null;
        if (release == null) return new Result(Outcome.UNREACHABLE, null, null);
        if (!newer(release)) {
            // Already there (the update may have finished before this TV restarted): say so, never go back.
            if (requestId != null) report(requestId, DONE, null);
            return new Result(Outcome.UP_TO_DATE, release, null);
        }
        if (!install) return new Result(Outcome.AVAILABLE, release, null);

        if (requestId != null) report(requestId, DOWNLOADING, null);
        Outcome fetched = fetch(release, file);
        if (fetched == Outcome.RATE_LIMITED || fetched == Outcome.UNREACHABLE) return new Result(fetched, release, null);
        if (fetched == Outcome.FAILED) {
            return fail(requestId, Outcome.FAILED, release, "The download stopped and could not be resumed.");
        }
        if (!release.sha256.equals(sha256(file))) {
            file.delete();
            return fail(requestId, Outcome.MISMATCH, release, "The download did not match its checksum.");
        }
        Archive archive = installer.read(file);
        if (archive == null || !PACKAGE.equals(archive.packageName)) {
            file.delete();
            return fail(requestId, Outcome.REFUSED, release, "The download is not a Polaris TV build.");
        }
        if (archive.versionCode <= installedCode) {
            file.delete();
            return fail(requestId, Outcome.REFUSED, release, "That build is not newer than the one on this TV.");
        }
        // Before the commit: a silent install replaces this process, and no report after it would be sent.
        if (requestId != null) report(requestId, INSTALLING, null);
        try {
            installer.install(file, release.size, requestId);
        } catch (IOException refused) {
            return fail(requestId, Outcome.FAILED, release, "This TV could not start the install.");
        }
        return new Result(Outcome.INSTALLING, release, null);
    }

    /** Newer by name, and by code too when the release publishes one. */
    private boolean newer(Release release) {
        if (validVersion(installedName) && compare(release.versionName, installedName) <= 0) return false;
        return release.versionCode < 0 || release.versionCode > installedCode;
    }

    /** Downloads what is missing into {@code file}, resuming from its length. */
    private Outcome fetch(Release release, Partial file) {
        String etag = "\"" + release.sha256 + "\"";
        if (file.length() > release.size) file.delete();
        for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            long offset = file.length();
            if (offset == release.size) return Outcome.INSTALLING;
            Download answer;
            try {
                answer = net.download(release.url, offset, offset > 0 ? etag : null);
            } catch (IOException unreachable) {
                // No answer at all: the part here is kept and the next run resumes from it.
                return Outcome.UNREACHABLE;
            }
            try (InputStream body = answer.body) {
                if (answer.status == 429) {
                    long wait = waitMs(answer.retryAfterSeconds);
                    if (wait < 0) return Outcome.RATE_LIMITED;
                    clock.sleep(wait);
                    continue;
                }
                if (answer.status == 416) {
                    // Past the end: what is here is not this file. Start over.
                    file.delete();
                    continue;
                }
                if (answer.status == 409) return Outcome.UNREACHABLE;
                if (answer.status != 200 && answer.status != 206) {
                    return answer.status >= 500 ? Outcome.UNREACHABLE : Outcome.FAILED;
                }
                // A 200 to a ranged request means the file changed: the part already here is thrown away.
                boolean append = answer.status == 206 && offset > 0;
                copy(body, file, append, release.size);
            } catch (IOException cut) {
                // Whatever arrived stays on disk; the next attempt asks for the rest.
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
                return Outcome.UNREACHABLE;
            }
        }
        return file.length() == release.size ? Outcome.INSTALLING : Outcome.FAILED;
    }

    private static void copy(InputStream body, Partial file, boolean append, long size) throws IOException {
        if (body == null) return;
        try (OutputStream out = file.open(append)) {
            byte[] chunk = new byte[64 * 1024];
            long written = append ? file.length() : 0;
            for (int read; (read = body.read(chunk)) != -1; ) {
                if (written + read > size) throw new IOException("Longer than the release says");
                out.write(chunk, 0, read);
                written += read;
            }
        }
    }

    static String sha256(Partial file) {
        try (InputStream in = file.read()) {
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

    /** The wait a Retry-After asks for, a short default when it gave none, or -1 when it is too long to wait. */
    static long waitMs(long retryAfterSeconds) {
        long ms = retryAfterSeconds < 0 ? 30_000 : retryAfterSeconds * 1000;
        return ms > MAX_WAIT_MS ? -1 : ms;
    }

    private interface Call {
        Reply run() throws IOException;
    }

    /** One JSON request, waiting out a 429 as Retry-After asks. Answers the 429 when the wait is too long. */
    private Reply call(Call call) throws IOException, InterruptedException {
        Reply reply = null;
        for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            reply = call.run();
            if (reply.status != 429) return reply;
            long wait = waitMs(reply.retryAfterSeconds);
            if (wait < 0) return reply;
            clock.sleep(wait);
        }
        return reply;
    }

    private Result fail(String requestId, Outcome outcome, Release release, String reason) {
        if (requestId != null) report(requestId, FAILED, reason);
        return new Result(outcome, release, reason);
    }

    /** The body of a report, or null for a state the instance does not take. */
    static String reportBody(String requestId, String state, String reason) {
        if (requestId == null) return null;
        try {
            JSONObject body = new JSONObject().put("id", requestId).put("state", state);
            String kept = cleanReason(reason);
            if (FAILED.equals(state) && kept != null) body.put("reason", kept);
            return body.toString();
        } catch (JSONException impossible) {
            return null;
        }
    }

    /** Trimmed, without control characters, and short enough for the instance to keep. */
    static String cleanReason(String reason) {
        if (reason == null) return null;
        String clean = reason.replaceAll("\\p{Cntrl}", " ").trim();
        if (clean.isEmpty()) return null;
        return clean.length() > MAX_REASON ? clean.substring(0, MAX_REASON).trim() : clean;
    }

    /** Tells the instance where a request it sent stands. Never throws: a lost report only delays the screen. */
    Sent report(String requestId, String state, String reason) {
        String body = reportBody(requestId, state, reason);
        if (body == null) return Sent.SKIPPED;
        try {
            Reply reply = call(() -> net.post(REPORT_PATH, body));
            if (reply.status == 404) return Sent.GONE;
            return reply.status == 204 || reply.status == 200 ? Sent.SENT : Sent.NOT_SENT;
        } catch (IOException | InterruptedException unreachable) {
            return Sent.NOT_SENT;
        }
    }

    /** The report state for a PackageInstaller status, or null for one that is not final (none today). */
    static String stateFor(int status) {
        if (status == STATUS_PENDING_USER_ACTION) return WAITING_CONFIRMATION;
        if (status == STATUS_SUCCESS) return DONE;
        return FAILED;
    }

    /** A readable sentence for a failed install, shown on the TV and on Polaris. */
    static String reasonFor(int status) {
        switch (status) {
            case STATUS_FAILURE_ABORTED: return "The update was cancelled on the TV.";
            case STATUS_FAILURE_BLOCKED: return "This TV blocks installs from Polaris TV.";
            case STATUS_FAILURE_CONFLICT: return "This TV refused the update: it is signed differently or older.";
            case STATUS_FAILURE_STORAGE: return "This TV does not have enough free space for the update.";
            case STATUS_FAILURE_INCOMPATIBLE: return "This build does not run on this TV.";
            case STATUS_FAILURE_INVALID: return "The update file was not a valid package.";
            case STATUS_FAILURE_TIMEOUT: return "The install took too long and was stopped.";
            default: return "The TV could not install the update.";
        }
    }

    /** Reports the installer's final word on a request from Polaris. */
    Sent onStatus(String requestId, int status) {
        String state = stateFor(status);
        return report(requestId, state, FAILED.equals(state) ? reasonFor(status) : null);
    }

    static Release readRelease(String body) {
        try {
            JSONObject answer = new JSONObject(body);
            String name = answer.optString("versionName", "").trim();
            String sha = answer.optString("sha256", "").toLowerCase(Locale.ROOT);
            String url = answer.optString("url", "");
            long size = answer.optLong("size", -1);
            long code = answer.isNull("versionCode") ? -1 : answer.optLong("versionCode", -1);
            // Only a path on the same instance: the key is never sent anywhere else.
            if (!validVersion(name) || !SHA256.matcher(sha).matches() || size <= 0 || !url.startsWith("/")
                    || url.startsWith("//")) {
                return null;
            }
            return new Release(name, code, size, sha, url);
        } catch (JSONException notARelease) {
            return null;
        }
    }

    private static String releaseFailure(String body) {
        String reason = null;
        try {
            reason = new JSONObject(body).optString("reason", null);
        } catch (JSONException unreadable) {
            // Fall through to the general sentence.
        }
        if ("mismatch".equals(reason)) return "The release did not match its checksum, so Polaris did not offer it.";
        if ("too-large".equals(reason)) return "The release is larger than Polaris accepts.";
        return "Polaris could not fetch the release.";
    }
}
