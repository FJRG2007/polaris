package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Locale;

public class SelfUpdateTest {

    private static final String REQUEST = "0190a000-0000-7000-8000-000000000001";
    private static final byte[] APK = "polaris tv build 3.5, pretend bytes".getBytes(StandardCharsets.UTF_8);

    private static String sha(byte[] bytes) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) {
            hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        }
        return hex.toString();
    }

    private static String release(String name, byte[] bytes) throws Exception {
        return new JSONObject().put("versionName", name).put("versionCode", JSONObject.NULL)
                .put("size", bytes.length).put("sha256", sha(bytes))
                .put("url", "/api/tv/update/apk?version=" + name).toString();
    }

    /** Answers queued replies in order and remembers every request. */
    private static final class FakeNet implements SelfUpdate.Net {
        final Deque<SelfUpdate.Reply> gets = new ArrayDeque<>();
        final Deque<Object> downloads = new ArrayDeque<>();
        final List<String> reports = new ArrayList<>();
        final List<long[]> ranges = new ArrayList<>();
        final List<String> ifRanges = new ArrayList<>();
        int reportStatus = 204;

        @Override
        public SelfUpdate.Reply get(String path) throws IOException {
            assertEquals(SelfUpdate.RELEASE_PATH, path);
            SelfUpdate.Reply reply = gets.poll();
            if (reply == null) throw new IOException("unreachable");
            return reply;
        }

        @Override
        public SelfUpdate.Reply post(String path, String json) {
            assertEquals(SelfUpdate.REPORT_PATH, path);
            reports.add(json);
            return new SelfUpdate.Reply(reportStatus, "", -1);
        }

        @Override
        public SelfUpdate.Download download(String path, long offset, String ifRange) throws IOException {
            ranges.add(new long[] {offset});
            ifRanges.add(ifRange);
            Object next = downloads.poll();
            if (next instanceof IOException) throw (IOException) next;
            if (next == null) throw new IOException("unreachable");
            return (SelfUpdate.Download) next;
        }

        List<String> states() throws Exception {
            List<String> states = new ArrayList<>();
            for (String report : reports) states.add(new JSONObject(report).getString("state"));
            return states;
        }
    }

    private static final class MemoryFile implements SelfUpdate.Partial {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        boolean deleted;

        @Override
        public long length() {
            return bytes.size();
        }

        @Override
        public OutputStream open(boolean append) {
            if (!append) bytes.reset();
            return bytes;
        }

        @Override
        public InputStream read() {
            return new ByteArrayInputStream(bytes.toByteArray());
        }

        @Override
        public void delete() {
            bytes.reset();
            deleted = true;
        }
    }

    private static final class FakeInstaller implements SelfUpdate.Installer {
        SelfUpdate.Archive archive = new SelfUpdate.Archive(SelfUpdate.PACKAGE, 14);
        int installs;
        String requestId;

        @Override
        public SelfUpdate.Archive read(SelfUpdate.Partial file) {
            return archive;
        }

        @Override
        public void install(SelfUpdate.Partial file, long size, String requestId) {
            installs++;
            this.requestId = requestId;
        }
    }

    private final FakeNet net = new FakeNet();
    private final FakeInstaller installer = new FakeInstaller();
    private final List<Long> sleeps = new ArrayList<>();
    private final MemoryFile file = new MemoryFile();

    private SelfUpdate update(String installedName, long installedCode) {
        return new SelfUpdate(net, installer, sleeps::add, installedName, installedCode);
    }

    private static SelfUpdate.Download answer(int status, byte[] body) {
        return new SelfUpdate.Download(status, -1, new ByteArrayInputStream(body));
    }

    /** A stream that hands over {@code good} bytes and then fails, as a dropped connection does. */
    private static InputStream cutAfter(byte[] body, int good) {
        return new InputStream() {
            int at;

            @Override
            public int read() throws IOException {
                if (at >= good) throw new IOException("connection reset");
                return body[at++] & 0xff;
            }
        };
    }

    @Test
    public void comparesDottedVersionsByNumber() {
        assertTrue(SelfUpdate.compare("3.10", "3.9") > 0);
        assertEquals(0, SelfUpdate.compare("3.4", "3.4.0"));
        assertTrue(SelfUpdate.compare("3.4", "3.5") < 0);
        assertTrue(SelfUpdate.compare("4", "3.99") > 0);
    }

    @Test
    public void versionQueryCarriesNameAndCode() {
        assertEquals("?versionName=3.4&versionCode=13", SelfUpdate.versionQuery("3.4", 13));
        assertEquals("?versionName=3.4", SelfUpdate.versionQuery("3.4", 0));
        assertEquals("?versionName=3.4-rc%2B1", SelfUpdate.versionQuery("3.4-rc+1", -1));
        assertEquals("", SelfUpdate.versionQuery("3.4 beta", 13));
    }

    @Test
    public void installsAVerifiedNewerBuildAndReportsEachStep() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        net.downloads.add(answer(200, APK));
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.INSTALLING, result.outcome);
        assertEquals(1, installer.installs);
        assertEquals(REQUEST, installer.requestId);
        assertEquals(Arrays.asList("downloading", "installing"), net.states());
        assertEquals(REQUEST, new JSONObject(net.reports.get(0)).getString("id"));
        assertNull(net.ifRanges.get(0));
    }

    @Test
    public void hashMismatchRefusesAndDeletesTheFile() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        byte[] tampered = APK.clone();
        tampered[0] ^= 1;
        net.downloads.add(answer(200, tampered));
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.MISMATCH, result.outcome);
        assertEquals(0, installer.installs);
        assertTrue(file.deleted);
        JSONObject last = new JSONObject(net.reports.get(net.reports.size() - 1));
        assertEquals("failed", last.getString("state"));
        assertEquals("The download did not match its checksum.", last.getString("reason"));
    }

    @Test
    public void sameVersionIsANoOp() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.4", APK), -1));
        SelfUpdate.Result result = update("3.4", 13).update(null, file);
        assertEquals(SelfUpdate.Outcome.UP_TO_DATE, result.outcome);
        assertTrue(net.ranges.isEmpty());
        assertEquals(0, installer.installs);
        assertTrue(net.reports.isEmpty());
        assertTrue(file.deleted);
    }

    @Test
    public void olderReleaseIsNeverInstalledEvenWhenPolarisAsks() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.3", APK), -1));
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.UP_TO_DATE, result.outcome);
        assertTrue(net.ranges.isEmpty());
        assertEquals(0, installer.installs);
        // This TV is already at or past what Polaris offers: the request is over.
        assertEquals(Arrays.asList("done"), net.states());
    }

    @Test
    public void aPackageWhoseVersionCodeIsNotNewerIsRefused() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        net.downloads.add(answer(200, APK));
        installer.archive = new SelfUpdate.Archive(SelfUpdate.PACKAGE, 13);
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.REFUSED, result.outcome);
        assertEquals(0, installer.installs);
        assertEquals("failed", net.states().get(net.states().size() - 1));
    }

    @Test
    public void anotherPackageIsRefused() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        net.downloads.add(answer(200, APK));
        installer.archive = new SelfUpdate.Archive("com.example.other", 99);
        assertEquals(SelfUpdate.Outcome.REFUSED, update("3.4", 13).update(null, file).outcome);
        assertEquals(0, installer.installs);
    }

    @Test
    public void aPublishedVersionCodeThatIsNotNewerIsANoOp() throws Exception {
        String body = new JSONObject(release("3.5", APK)).put("versionCode", 13).toString();
        net.gets.add(new SelfUpdate.Reply(200, body, -1));
        assertEquals(SelfUpdate.Outcome.UP_TO_DATE, update("3.4", 13).check().outcome);
    }

    @Test
    public void retryAfterIsRespectedOnTheReleaseAndTheDownload() throws Exception {
        net.gets.add(new SelfUpdate.Reply(429, "", 7));
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        net.downloads.add(new SelfUpdate.Download(429, 3, null));
        net.downloads.add(answer(200, APK));
        assertEquals(SelfUpdate.Outcome.INSTALLING, update("3.4", 13).update(null, file).outcome);
        assertEquals(Arrays.asList(7_000L, 3_000L), sleeps);
    }

    @Test
    public void aRetryAfterTooLongEndsTheRunWithoutAFailure() throws Exception {
        net.gets.add(new SelfUpdate.Reply(429, "", 3600));
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.RATE_LIMITED, result.outcome);
        assertTrue(sleeps.isEmpty());
        assertTrue(net.reports.isEmpty());
    }

    @Test
    public void aCutDownloadResumesFromWhatArrived() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        net.downloads.add(new SelfUpdate.Download(200, -1, cutAfter(APK, 10)));
        net.downloads.add(answer(206, Arrays.copyOfRange(APK, 10, APK.length)));
        assertEquals(SelfUpdate.Outcome.INSTALLING, update("3.4", 13).update(null, file).outcome);
        assertEquals(0, net.ranges.get(0)[0]);
        assertEquals(10, net.ranges.get(1)[0]);
        assertEquals("\"" + sha(APK) + "\"", net.ifRanges.get(1));
        assertEquals(1, installer.installs);
    }

    @Test
    public void aPartLeftByAnEarlierRunIsResumed() throws Exception {
        file.open(true).write(APK, 0, 5);
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        net.downloads.add(answer(206, Arrays.copyOfRange(APK, 5, APK.length)));
        assertEquals(SelfUpdate.Outcome.INSTALLING, update("3.4", 13).update(null, file).outcome);
        assertEquals(5, net.ranges.get(0)[0]);
    }

    @Test
    public void aChangedFileAnswersWholeAndReplacesThePart() throws Exception {
        file.open(true).write("stale".getBytes(StandardCharsets.UTF_8));
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        net.downloads.add(answer(200, APK));
        assertEquals(SelfUpdate.Outcome.INSTALLING, update("3.4", 13).update(null, file).outcome);
        assertEquals(APK.length, file.length());
    }

    @Test
    public void noAnswerKeepsThePartAndReportsNoFailure() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        net.downloads.add(new IOException("unreachable"));
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.UNREACHABLE, result.outcome);
        assertEquals(Arrays.asList("downloading"), net.states());
    }

    @Test
    public void noReleaseIsReportedAsAReadableFailure() throws Exception {
        net.gets.add(new SelfUpdate.Reply(204, "", -1));
        assertEquals(SelfUpdate.Outcome.NO_RELEASE, update("3.4", 13).update(REQUEST, file).outcome);
        JSONObject report = new JSONObject(net.reports.get(0));
        assertEquals("failed", report.getString("state"));
        assertEquals("This Polaris has no TV build to install.", report.getString("reason"));
    }

    @Test
    public void aMismatchOnTheInstanceIsNamed() throws Exception {
        net.gets.add(new SelfUpdate.Reply(502, "{\"error\":\"x\",\"reason\":\"mismatch\"}", -1));
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.FAILED, result.outcome);
        assertTrue(result.reason.contains("checksum"));
        assertEquals(SelfUpdate.Failure.RELEASE_MISMATCH, result.failure);
    }

    @Test
    public void installerFailuresKeepTheirKindForTheTv() {
        assertEquals(SelfUpdate.Failure.BLOCKED, SelfUpdate.failureFor(SelfUpdate.STATUS_FAILURE_BLOCKED));
        assertEquals(SelfUpdate.Failure.NOT_INSTALLED, SelfUpdate.failureFor(SelfUpdate.STATUS_FAILURE));
        assertEquals("This TV blocks installs from Polaris TV.", SelfUpdate.reasonFor(SelfUpdate.STATUS_FAILURE_BLOCKED));
    }

    @Test
    public void aCheckNeverDownloads() throws Exception {
        net.gets.add(new SelfUpdate.Reply(200, release("3.5", APK), -1));
        SelfUpdate.Result result = update("3.4", 13).check();
        assertEquals(SelfUpdate.Outcome.AVAILABLE, result.outcome);
        assertEquals("3.5", result.release.versionName);
        assertTrue(net.ranges.isEmpty());
        assertTrue(net.reports.isEmpty());
    }

    @Test
    public void aReleaseOnAnotherHostIsNotFollowed() throws Exception {
        String body = new JSONObject(release("3.5", APK)).put("url", "//evil.example.test/apk").toString();
        assertNull(SelfUpdate.readRelease(body));
        body = new JSONObject(release("3.5", APK)).put("sha256", "abc").toString();
        assertNull(SelfUpdate.readRelease(body));
    }

    @Test
    public void reportPayloadsKeepAReasonOnlyOnFailure() throws Exception {
        JSONObject failed = new JSONObject(SelfUpdate.reportBody(REQUEST, "failed", " Line\none "));
        assertEquals("Line one", failed.getString("reason"));
        JSONObject downloading = new JSONObject(SelfUpdate.reportBody(REQUEST, "downloading", "ignored"));
        assertFalse(downloading.has("reason"));
        assertNull(SelfUpdate.reportBody(null, "downloading", null));
        char[] longReason = new char[300];
        Arrays.fill(longReason, 'a');
        assertEquals(200, SelfUpdate.cleanReason(new String(longReason)).length());
    }

    @Test
    public void aRequestPolarisNoLongerKnowsIsGone() {
        net.reportStatus = 404;
        assertEquals(SelfUpdate.Sent.GONE, update("3.4", 13).report(REQUEST, "downloading", null));
        assertEquals(SelfUpdate.Sent.SKIPPED, update("3.4", 13).report(null, "downloading", null));
    }

    @Test
    public void installerStatusesBecomeReports() throws Exception {
        SelfUpdate update = update("3.4", 13);
        update.onStatus(REQUEST, SelfUpdate.STATUS_PENDING_USER_ACTION);
        update.onStatus(REQUEST, SelfUpdate.STATUS_FAILURE_ABORTED);
        update.onStatus(REQUEST, SelfUpdate.STATUS_SUCCESS);
        assertEquals(Arrays.asList("waiting-confirmation", "failed", "done"), net.states());
        assertEquals("The update was cancelled on the TV.", new JSONObject(net.reports.get(1)).getString("reason"));
    }

    @Test
    public void theHomeKeyEditionAsksForItsOwnApk() {
        assertEquals("/api/tv/update", SelfUpdate.releasePath(""));
        assertEquals("/api/tv/update?edition=home-key", SelfUpdate.releasePath("home-key"));
    }

    @Test
    public void aReleaseCarriesTheEditionTheInstanceNamed() {
        String sha = "a".repeat(64);
        String body = "{\"versionName\":\"3.6\",\"size\":10,\"sha256\":\"" + sha
                + "\",\"url\":\"/api/tv/update/apk?version=3.6&edition=home-key\",\"edition\":\"home-key\"}";
        assertEquals("home-key", SelfUpdate.readRelease(body).edition);
        // An instance from before editions names none, which is the ordinary build.
        assertEquals("", SelfUpdate.readRelease(body.replace(",\"edition\":\"home-key\"", "")).edition);
        // The instance names the ordinary build "standard", which is the edition this build calls empty.
        assertEquals("", SelfUpdate.readRelease(body.replace("\"edition\":\"home-key\"", "\"edition\":\"standard\"")).edition);
    }

    @Test
    public void theOrdinaryBuildInstallsTheStandardReleaseTheInstanceNames() throws Exception {
        assertEquals("", SelfUpdate.EDITION);
        String body = new JSONObject(release("3.5", APK)).put("edition", "standard").toString();
        net.gets.add(new SelfUpdate.Reply(200, body, -1));
        net.downloads.add(answer(200, APK));
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.INSTALLING, result.outcome);
        assertEquals(1, installer.installs);
    }

    @Test
    public void theOrdinaryBuildRefusesTheHomeKeyRelease() throws Exception {
        String body = new JSONObject(release("3.5", APK)).put("edition", "home-key").toString();
        net.gets.add(new SelfUpdate.Reply(200, body, -1));
        SelfUpdate.Result result = update("3.4", 13).update(REQUEST, file);
        assertEquals(SelfUpdate.Outcome.NO_RELEASE, result.outcome);
        assertEquals(0, installer.installs);
    }
}
