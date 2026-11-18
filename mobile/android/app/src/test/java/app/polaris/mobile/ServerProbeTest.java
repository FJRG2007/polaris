package app.polaris.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerProbeTest {
    @Test
    public void identityNeedsTheMarkerAndAProtocol() {
        assertTrue(ServerProbe.isIdentity("{\"product\":\"polaris\",\"protocol\":1}"));
        assertFalse(ServerProbe.isIdentity("{\"product\":\"other\",\"protocol\":1}"));
        assertFalse(ServerProbe.isIdentity("{\"product\":\"polaris\"}"));
        assertFalse(ServerProbe.isIdentity("{\"product\":\"polaris\",\"protocol\":0}"));
        assertFalse(ServerProbe.isIdentity("<html>"));
        assertFalse(ServerProbe.isIdentity(null));
    }

    @Test
    public void anOlderInstallAnswersWithItsInstance() {
        String key = "A".repeat(43);
        assertTrue(ServerProbe.isInstance("{\"id\":\"abcdefgh\",\"publicKey\":\"" + key + "\",\"addresses\":[]}"));
        assertFalse(ServerProbe.isInstance("{\"id\":\"abc\",\"publicKey\":\"" + key + "\",\"addresses\":[]}"));
        assertFalse(ServerProbe.isInstance("{\"id\":\"abcdefgh\",\"publicKey\":\"short\",\"addresses\":[]}"));
    }

    @Test
    public void healthTellsStartingFromNotPolaris() {
        assertEquals(ServerProbe.Verdict.POLARIS, ServerProbe.healthVerdict(200, "{\"status\":\"ok\"}"));
        assertEquals(ServerProbe.Verdict.STARTING, ServerProbe.healthVerdict(503, "{\"status\":\"error\"}"));
        assertEquals(ServerProbe.Verdict.NOT_POLARIS, ServerProbe.healthVerdict(200, "{\"ok\":true}"));
    }
}
