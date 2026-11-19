package app.polaris.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UpdateCheckTest {
    private static String refs(String... tags) {
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < tags.length; i++) {
            if (i > 0) json.append(',');
            json.append("{\"ref\":\"refs/tags/").append(tags[i]).append("\"}");
        }
        return json.append(']').toString();
    }

    @Test
    public void offersTheNewestNewerTag() {
        String[] found = UpdateCheck.newest(refs("android-v0.1.0", "android-v0.1.10", "android-v0.1.9"), "0.1.0");
        assertArrayEquals(new String[] {
            "0.1.10", "https://github.com/FJRG2007/polaris/releases/download/android-v0.1.10/polaris-android.apk"
        }, found);
    }

    @Test
    public void offersNothingWhenCurrentIsNewest() {
        assertNull(UpdateCheck.newest(refs("android-v0.1.0"), "0.1.0"));
        assertNull(UpdateCheck.newest("not json", "0.1.0"));
    }

    @Test
    public void ignoresOtherProductsAndOddTags() {
        assertNull(UpdateCheck.newest(refs("tv-v9.0", "android-vlatest", "android-v1.0/../x"), "0.1.0"));
    }

    @Test
    public void comparesNumerically() {
        assertTrue(UpdateCheck.compare("0.1.10", "0.1.9") > 0);
        assertTrue(UpdateCheck.compare("1.0", "0.9.9") > 0);
        assertEquals(0, UpdateCheck.compare("0.1", "0.1.0"));
    }

    @Test
    public void leavesStoreInstallsToTheirStore() {
        assertTrue(UpdateCheck.storeInstalled("com.android.vending"));
        assertTrue(UpdateCheck.storeInstalled("org.fdroid.fdroid"));
        assertFalse(UpdateCheck.storeInstalled(null));
        assertFalse(UpdateCheck.storeInstalled("com.google.android.packageinstaller"));
    }
}
