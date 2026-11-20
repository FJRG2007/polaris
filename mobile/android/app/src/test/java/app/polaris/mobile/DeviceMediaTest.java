package app.polaris.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DeviceMediaTest {
    @Test
    public void readsAPhotoOrAVideoByItsNumber() {
        DeviceMedia.Item photo = DeviceMedia.Item.parse("image:123");
        assertFalse(photo.video);
        assertEquals(123L, photo.number);
        assertTrue(DeviceMedia.Item.parse("video:45").video);
    }

    @Test
    public void refusesAnythingElseThePageSends() {
        assertNull(DeviceMedia.Item.parse(null));
        assertNull(DeviceMedia.Item.parse(""));
        assertNull(DeviceMedia.Item.parse("file:1"));
        assertNull(DeviceMedia.Item.parse("image:1 OR 1=1"));
        assertNull(DeviceMedia.Item.parse("image:../../data"));
        assertNull(DeviceMedia.Item.parse("image:99999999999999999999"));
    }
}
