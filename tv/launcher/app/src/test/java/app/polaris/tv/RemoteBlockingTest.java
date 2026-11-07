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

    private static final String FIRST = "0190a000-0000-7000-8000-00000000000a";
    private static final String SECOND = "0190a000-0000-7000-8000-00000000000b";

    private static RemoteBlocking.Step step(Boolean desired, String choice, String actedOn) {
        return RemoteBlocking.step(desired, RemoteBlocking.choiceKey(desired, choice), actedOn);
    }

    @Test
    public void readsTheChoiceId() {
        assertEquals(FIRST, RemoteBlocking.desiredChoice(new JSONObject(
                "{\"desired\":{\"blocking\":true,\"choice\":\"" + FIRST.toUpperCase() + "\"}}")));
        assertNull(RemoteBlocking.desiredChoice(new JSONObject("{\"desired\":{\"blocking\":true}}")));
        assertNull(RemoteBlocking.desiredChoice(new JSONObject(
                "{\"desired\":{\"blocking\":true,\"choice\":\"x&blocking=on\"}}")));
        assertNull(RemoteBlocking.desiredChoice(new JSONObject("{\"desired\":{\"choice\":7}}")));
        assertNull(RemoteBlocking.desiredChoice(null));
    }

    @Test
    public void actsOncePerChoice() {
        assertEquals(RemoteBlocking.Step.NOTHING, step(null, null, null));
        assertEquals(RemoteBlocking.Step.NOTHING, step(null, FIRST, FIRST));
        assertEquals(RemoteBlocking.Step.TURN_ON, step(true, FIRST, null));
        assertEquals(RemoteBlocking.Step.NOTHING, step(true, FIRST, FIRST));
        assertEquals(RemoteBlocking.Step.TURN_OFF, step(false, SECOND, FIRST));
        assertEquals(RemoteBlocking.Step.NOTHING, step(false, SECOND, SECOND));
    }

    @Test
    public void triesAgainWhenTheSameValueIsAskedAgain() {
        // Turned on, failed, asked for on again: a new id, so a new attempt.
        assertEquals(RemoteBlocking.Step.TURN_ON, step(true, SECOND, FIRST));
    }

    @Test
    public void actsOncePerValueForAnInstanceThatSendsNoId() {
        assertEquals(RemoteBlocking.Step.TURN_ON, step(true, null, null));
        assertEquals(RemoteBlocking.Step.TURN_ON, step(true, null, "false"));
        assertEquals(RemoteBlocking.Step.NOTHING, step(true, null, "true"));
        assertEquals(RemoteBlocking.Step.TURN_OFF, step(false, null, "true"));
        assertEquals(RemoteBlocking.Step.NOTHING, step(false, null, "false"));
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
                RemoteBlocking.withReport("/api/tv/state?versionName=1.0", "on", null));
        assertEquals("/api/tv/state?blocking=no-filter",
                RemoteBlocking.withReport("/api/tv/state", "no-filter", null));
        assertEquals("/api/tv/state?blocking=on&blockingChoice=" + FIRST,
                RemoteBlocking.withReport("/api/tv/state", "on", FIRST));
        assertEquals("/api/tv/state?blocking=on", RemoteBlocking.withReport("/api/tv/state", "on", "not-an-id"));
        assertEquals("/api/tv/state", RemoteBlocking.withReport("/api/tv/state", null, FIRST));
        assertEquals("/api/tv/state", RemoteBlocking.withReport("/api/tv/state", "", null));
    }
}
