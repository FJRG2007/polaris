package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONObject;
import org.junit.Test;

public class RemoteBlockingTest {

    private static Boolean desired(String json) {
        return RemoteBlocking.desiredBlocking(new JSONObject(json));
    }

    @Test
    public void readsTheOwnersChoice() {
        assertEquals(Boolean.TRUE, desired("{\"desired\":{\"blocking\":true}}"));
        assertEquals(Boolean.FALSE, desired("{\"desired\":{\"blocking\":false,\"theme\":\"stockholm\"}}"));
    }

    @Test
    public void keepsItsOwnSettingWhenNothingWasChosenOrTheBlockIsMalformed() {
        assertNull(desired("{\"desired\":null}"));
        assertNull(desired("{}"));
        assertNull(desired("{\"desired\":{}}"));
        assertNull(desired("{\"desired\":{\"blocking\":\"true\"}}"));
        assertNull(desired("{\"desired\":true}"));
        assertNull(RemoteBlocking.desiredBlocking(null));
    }

    @Test
    public void actsOncePerChoice() {
        assertEquals(RemoteBlocking.Step.NOTHING, RemoteBlocking.step(null, null));
        assertEquals(RemoteBlocking.Step.NOTHING, RemoteBlocking.step(null, true));
        assertEquals(RemoteBlocking.Step.TURN_ON, RemoteBlocking.step(true, null));
        assertEquals(RemoteBlocking.Step.TURN_ON, RemoteBlocking.step(true, false));
        assertEquals(RemoteBlocking.Step.NOTHING, RemoteBlocking.step(true, true));
        assertEquals(RemoteBlocking.Step.TURN_OFF, RemoteBlocking.step(false, null));
        assertEquals(RemoteBlocking.Step.TURN_OFF, RemoteBlocking.step(false, true));
        assertEquals(RemoteBlocking.Step.NOTHING, RemoteBlocking.step(false, false));
    }

    @Test
    public void reportsEveryOutcomeInTheInstancesWords() {
        assertEquals("on", RemoteBlocking.report(PrivateDns.Result.ON));
        assertEquals("off", RemoteBlocking.report(PrivateDns.Result.OFF));
        assertEquals("failed", RemoteBlocking.report(PrivateDns.Result.REVERTED));
        assertEquals("unavailable", RemoteBlocking.report(PrivateDns.Result.UNAVAILABLE));
        assertEquals("no-permission", RemoteBlocking.report(PrivateDns.Result.NO_PERMISSION));
        assertEquals("no-filter", RemoteBlocking.report(PrivateDns.Result.BAD_HOSTNAME));
        assertEquals("left-as-set", RemoteBlocking.report(PrivateDns.Result.LEFT_AS_SET));
        assertNull(RemoteBlocking.report(PrivateDns.Result.UNCHANGED));
        assertNull(RemoteBlocking.report(null));
    }

    @Test
    public void saysWhatTheTvIsNow() {
        assertEquals("on", RemoteBlocking.current(null, "dns.example.test"));
        assertEquals("on", RemoteBlocking.current("off", "dns.example.test"));
        assertEquals("left-as-set", RemoteBlocking.current("on", null));
        assertEquals("failed", RemoteBlocking.current("failed", null));
        assertEquals("off", RemoteBlocking.current("off", null));
        assertNull(RemoteBlocking.current(null, null));
    }

    @Test
    public void addsTheReportToTheQuery() {
        assertEquals("/api/tv/state?versionName=1.0&blocking=on",
                RemoteBlocking.withReport("/api/tv/state?versionName=1.0", "on"));
        assertEquals("/api/tv/state?blocking=no-filter", RemoteBlocking.withReport("/api/tv/state", "no-filter"));
        assertEquals("/api/tv/state", RemoteBlocking.withReport("/api/tv/state", null));
        assertEquals("/api/tv/state", RemoteBlocking.withReport("/api/tv/state", ""));
    }
}
