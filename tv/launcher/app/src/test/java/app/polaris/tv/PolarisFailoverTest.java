package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.IOException;
import java.net.ConnectException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import javax.net.ssl.SSLHandshakeException;

/** The rule that matters: an address that has not proved itself never sees the token. */
public class PolarisFailoverTest {

    private static final String PRIMARY = "https://polaris.example.com";
    private static final String LOCAL = "http://polaris.local";

    private static byte[] hex(String value) {
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(value.substring(2 * i, 2 * i + 2), 16);
        }
        return out;
    }

    // RFC 8032 section 7.1, TEST 1 and TEST 2.
    private static final String KEY_1 = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    private static final String SIG_1 = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
            + "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
    private static final String KEY_2 = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
    private static final String SIG_2 = "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
            + "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00";

    @Test
    public void verifiesTheRfcVectors() {
        assertTrue(PolarisEd25519.verify(hex(KEY_1), new byte[0], hex(SIG_1)));
        assertTrue(PolarisEd25519.verify(hex(KEY_2), hex("72"), hex(SIG_2)));
    }

    @Test
    public void refusesWhatWasNotSigned() {
        assertFalse(PolarisEd25519.verify(hex(KEY_1), hex("72"), hex(SIG_1)));
        assertFalse(PolarisEd25519.verify(hex(KEY_2), new byte[0], hex(SIG_1)));
        byte[] flipped = hex(SIG_1);
        flipped[10] ^= 1;
        assertFalse(PolarisEd25519.verify(hex(KEY_1), new byte[0], flipped));
        assertFalse(PolarisEd25519.verify(new byte[31], new byte[0], hex(SIG_1)));
        assertFalse(PolarisEd25519.verify(hex(KEY_1), new byte[0], new byte[63]));
    }

    @Test
    public void refusesAnSAtOrAboveTheGroupOrder() {
        byte[] high = hex(SIG_1);
        Arrays.fill(high, 32, 64, (byte) 0xFF);
        assertFalse(PolarisEd25519.verify(hex(KEY_1), new byte[0], high));
    }

    @Test
    public void readsOrigins() {
        assertEquals("https://a.example", PolarisFailover.readOrigin(" https://A.example/x?y=1 "));
        assertEquals("http://a.local:3000", PolarisFailover.readOrigin("http://a.local:3000"));
        assertEquals("https://a.example", PolarisFailover.readOrigin("https://a.example:443"));
        assertNull(PolarisFailover.readOrigin("ftp://a.example"));
        assertNull(PolarisFailover.readOrigin("https://user:pw@a.example"));
        assertNull(PolarisFailover.readOrigin("not an address"));
        assertNull(PolarisFailover.readOrigin(null));
    }

    @Test
    public void readsWhatWasTypedOnTheRemote() {
        assertEquals("https://polaris.example.com", PolarisFailover.readTyped("polaris.example.com"));
        assertEquals("http://polaris.local", PolarisFailover.readTyped("polaris.local"));
        assertEquals("http://192.168.1.50:3000", PolarisFailover.readTyped("192.168.1.50:3000"));
        assertEquals("http://polaris.example.com", PolarisFailover.readTyped("http://polaris.example.com"));
        assertNull(PolarisFailover.readTyped("   "));
        assertEquals("https://10.example.com", PolarisFailover.readTyped("10.example.com"));
        assertEquals("https://192.168.example.com", PolarisFailover.readTyped("192.168.example.com"));
        assertEquals("https://172.16.example.com", PolarisFailover.readTyped("172.16.example.com"));
        assertEquals("http://10.0.0.2", PolarisFailover.readTyped("10.0.0.2"));
        assertEquals("http://172.31.0.2", PolarisFailover.readTyped("172.31.0.2"));
        assertTrue(PolarisFailover.plain("http://10.0.0.2"));
        assertFalse(PolarisFailover.plain("https://10.0.0.2"));
    }

    @Test
    public void instanceAnswerIsStrict() {
        String key = String.join("", Collections.nCopies(43, "A"));
        assertNotNull(PolarisFailover.readInstance(
                "{\"id\":\"abcdefgh\",\"publicKey\":\"" + key + "\",\"addresses\":[\"http://polaris.local\"]}"));
        assertNull(PolarisFailover.readInstance(
                "{\"id\":\"short\",\"publicKey\":\"" + key + "\",\"addresses\":[]}"));
        assertNull(PolarisFailover.readInstance(
                "{\"id\":\"abcdefgh\",\"publicKey\":\"nope\",\"addresses\":[]}"));
        assertNull(PolarisFailover.readInstance(
                "{\"id\":\"abcdefgh\",\"publicKey\":\"" + key + "\",\"addresses\":[\"ftp://x\"]}"));
        assertNull(PolarisFailover.readInstance("<html>"));
    }

    @Test
    public void gatewayStatuses() {
        assertTrue(PolarisFailover.isGatewayFailure(502));
        assertTrue(PolarisFailover.isGatewayFailure(530));
        assertFalse(PolarisFailover.isGatewayFailure(401));
        assertFalse(PolarisFailover.isGatewayFailure(500));
    }

    /** Scripted network: the primary is down, the alternate answers the challenge as told. */
    private static final class Network implements PolarisFailover.Transport {
        final List<String> tokensSentTo = new ArrayList<>();
        boolean primaryUp;
        IOException localFailure;
        String challengeAnswer = "{\"id\":\"other-one\",\"nonce\":\"x\",\"signature\":\"y\"}";

        @Override
        public PolarisFailover.Reply send(String method, String url, String body, String token) throws IOException {
            if (token != null) tokensSentTo.add(url);
            if (url.startsWith(PRIMARY)) {
                if (!primaryUp) throw new ConnectException("down");
                return new PolarisFailover.Reply(200, "{}");
            }
            if (localFailure != null) throw localFailure;
            return new PolarisFailover.Reply(200, challengeAnswer);
        }
    }

    private static PolarisFailover failover(Network network) {
        String key = KEY_ENCODED;
        return new PolarisFailover(network, PRIMARY, new PolarisFailover.Instance(
                "instance-1", key, Arrays.asList(PRIMARY, LOCAL)));
    }

    private static final String KEY_ENCODED = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(hex(KEY_1));

    @Test
    public void usesThePrimaryWhenItAnswers() throws IOException {
        Network network = new Network();
        network.primaryUp = true;
        PolarisFailover failover = failover(network);
        assertEquals(200, failover.request("GET", "/api/tv/state", null, "token").status);
        assertFalse(failover.local());
    }

    @Test
    public void aLookAlikeNeverSeesTheToken() {
        Network network = new Network();
        PolarisFailover failover = failover(network);
        try {
            failover.request("GET", "/api/tv/state", null, "token");
        } catch (IOException expected) {
            assertEquals("down", expected.getMessage());
        }
        assertEquals(Collections.singletonList(PRIMARY + "/api/tv/state"), network.tokensSentTo);
        assertEquals(Collections.singletonList(LOCAL), failover.refused());
        assertFalse(failover.local());
    }

    @Test
    public void aRepeatedIdWithABadSignatureIsNotEnough() {
        Network network = new Network();
        String forged = String.join("", Collections.nCopies(86, "A"));
        network.challengeAnswer = "{\"id\":\"instance-1\",\"signature\":\"" + forged + "\"}";
        PolarisFailover failover = failover(network);
        try {
            failover.request("GET", "/x", null, "token");
        } catch (IOException expected) {
            assertEquals(1, network.tokensSentTo.size());
        }
        assertEquals(Collections.singletonList(LOCAL), failover.refused());
    }

    @Test
    public void anUntrustedCertificateIsToldApartFromADifferentPolaris() {
        Network network = new Network();
        network.localFailure = new SSLHandshakeException("untrusted");
        PolarisFailover failover = failover(network);
        try {
            failover.request("GET", "/x", null, "token");
        } catch (IOException expected) {
            assertEquals(1, network.tokensSentTo.size());
        }
        assertEquals(Collections.singletonList(LOCAL), failover.untrusted());
        assertTrue(failover.refused().isEmpty());
    }

    @Test
    public void theSignedMessageIsTheServersOne() {
        assertEquals("polaris-instance-v1\nid\nhttp://polaris.local\nnonce",
                PolarisFailover.challengeMessage("id", "http://polaris.local", "nonce"));
        assertEquals(43, PolarisFailover.freshNonce(new java.security.SecureRandom())
                .getBytes(StandardCharsets.US_ASCII).length);
    }

    @Test
    public void theRecordIsAskedForAgainOnlyWhenItIsDue() {
        long now = 1_000_000_000_000L;
        assertTrue(PolarisFailover.relearnDue(false, 0, now));
        assertTrue(PolarisFailover.relearnDue(true, 0, now));
        assertFalse(PolarisFailover.relearnDue(false, now - 5 * 60_000L, now));
        assertTrue(PolarisFailover.relearnDue(false, now - PolarisFailover.UNPINNED_RELEARN_MS, now));
        assertFalse(PolarisFailover.relearnDue(true, now - PolarisFailover.UNPINNED_RELEARN_MS, now));
        assertTrue(PolarisFailover.relearnDue(true, now - PolarisFailover.RELEARN_MS, now));
        assertTrue(PolarisFailover.relearnDue(true, now + 60_000L, now));
    }
}
