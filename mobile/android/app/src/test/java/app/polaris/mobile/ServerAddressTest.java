package app.polaris.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerAddressTest {
    @Test
    public void typedHostBecomesAnHttpsOrigin() {
        assertEquals("https://polaris.example.com", ServerAddress.origin("  polaris.example.com "));
        assertEquals("https://polaris.example.com", ServerAddress.origin("HTTPS://Polaris.Example.com/home?x=1"));
        assertEquals("https://polaris.example.com", ServerAddress.origin("https://polaris.example.com:443/"));
    }

    @Test
    public void keepsAnUnusualPortAndPlainHttp() {
        assertEquals("https://polaris.example.com:8443", ServerAddress.origin("polaris.example.com:8443"));
        assertEquals("http://192.168.1.10:3000", ServerAddress.origin("http://192.168.1.10:3000/"));
    }

    @Test
    public void refusesWhatCannotBeAnOrigin() {
        assertNull(ServerAddress.origin(""));
        assertNull(ServerAddress.origin("   "));
        assertNull(ServerAddress.origin(null));
        assertNull(ServerAddress.origin("ftp://polaris.example.com"));
        assertNull(ServerAddress.origin("javascript:alert(1)"));
        assertNull(ServerAddress.origin("https://user:pass@polaris.example.com"));
        assertNull(ServerAddress.origin("https://"));
        assertNull(ServerAddress.origin("a".repeat(ServerAddress.MAX_LENGTH + 1)));
    }

    @Test
    public void sameOriginKeepsOwnLinksInsideOnly() {
        String origin = "https://polaris.example.com";
        assertTrue(ServerAddress.sameOrigin(origin, "https://polaris.example.com/chat"));
        assertFalse(ServerAddress.sameOrigin(origin, "https://polaris.example.com.evil.test/"));
        assertFalse(ServerAddress.sameOrigin(origin, "http://polaris.example.com/chat"));
        assertFalse(ServerAddress.sameOrigin(origin, "mailto:someone@example.com"));
        assertFalse(ServerAddress.sameOrigin(null, "https://polaris.example.com/"));
    }
}
