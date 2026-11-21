package app.polaris.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class SelfUpdateTest {
    private static final String APK = "a".repeat(64);
    private static final String AAB = "B".repeat(64);

    @Test
    public void readsTheApkLineOfSha256sum() {
        String sums = APK + "  polaris-android.apk\n" + AAB + "  polaris-android.aab\n";
        assertEquals(APK, SelfUpdate.digestFor(sums, "polaris-android.apk"));
        assertEquals("b".repeat(64), SelfUpdate.digestFor(sums, "polaris-android.aab"));
    }

    @Test
    public void acceptsBinaryModeMarkers() {
        assertEquals(APK, SelfUpdate.digestFor(APK + " *polaris-android.apk", "polaris-android.apk"));
    }

    @Test
    public void refusesMissingOrMalformedEntries() {
        assertNull(SelfUpdate.digestFor(null, "polaris-android.apk"));
        assertNull(SelfUpdate.digestFor(AAB + "  polaris-android.aab", "polaris-android.apk"));
        assertNull(SelfUpdate.digestFor("xyz  polaris-android.apk", "polaris-android.apk"));
        assertNull(SelfUpdate.digestFor(APK + "  polaris-android.apk.evil", "polaris-android.apk"));
    }
}
