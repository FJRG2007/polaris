package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.List;

import javax.net.ssl.X509TrustManager;

/**
 * The local CA pin: a chain is accepted only when it really chains, by signature, to the pinned CA and names the
 * host. Fixtures in src/test/resources/polaris-local-ca were made with openssl the way local-ca-service.ts makes
 * them (RSA 2048, SHA-256):
 * ca.pem - the instance's local CA; leaf.pem - polaris.local and 192.168.1.50, signed by it;
 * forged.pem - the same leaf signed by another key under a CA of the same name; wronghost.pem - other.local and
 * 192.168.1.99, signed by the CA; expired.pem - signed by the CA, valid only during 2020.
 */
public class PolarisLocalCaTest {

    /** {@code openssl x509 -in ca.pem -noout -fingerprint -sha256}, lowercase without colons. */
    private static final String CA_PIN = "e1b1c05b3fdc90b2777c68941ada03d8747a255892d112c9a4955e130aac4d49";
    private static final String OTHER_PIN = "00" + CA_PIN.substring(2);
    private static final List<String> PINS = Collections.singletonList(CA_PIN);
    private static final String KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    /** Inside every fixture's validity except expired.pem's. */
    private static final Date NOW = new Date(1_811_808_000_000L); // 2027-06-01T00:00:00Z

    private static X509Certificate cert(String name) {
        try (InputStream in = PolarisLocalCaTest.class.getResourceAsStream("/polaris-local-ca/" + name + ".pem")) {
            assertNotNull(name, in);
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
        } catch (IOException | CertificateException unreadable) {
            throw new AssertionError(unreadable);
        }
    }

    private static X509Certificate[] chain(String... names) {
        X509Certificate[] chain = new X509Certificate[names.length];
        for (int i = 0; i < names.length; i++) chain[i] = cert(names[i]);
        return chain;
    }

    @Test
    public void fingerprintIsTheCertificatesSha256() {
        assertEquals(CA_PIN, PolarisLocalCa.sha256(cert("ca")));
    }

    @Test
    public void acceptsOnlyAChainThatReallyEndsInThePin() {
        Object[][] table = {
                // chain, host, pins, now, accepted
                {chain("leaf", "ca"), "polaris.local", PINS, NOW, true},
                {chain("leaf", "ca"), "POLARIS.LOCAL", PINS, NOW, true},
                {chain("leaf", "ca"), "192.168.1.50", PINS, NOW, true},
                {chain("wronghost", "ca"), "other.local", PINS, NOW, true},
                {chain("forged", "ca"), "polaris.local", PINS, NOW, false},
                {chain("expired", "ca"), "polaris.local", PINS, NOW, false},
                {chain("wronghost", "ca"), "polaris.local", PINS, NOW, false},
                {chain("wronghost", "ca"), "192.168.1.50", PINS, NOW, false},
                {chain("leaf", "ca"), "polaris.example.com", PINS, NOW, false},
                {chain("leaf", "ca"), "sub.polaris.local", PINS, NOW, false},
                {chain("leaf", "ca"), "polaris.local", Collections.singletonList(OTHER_PIN), NOW, false},
                {chain("leaf", "ca"), "polaris.local", Collections.emptyList(), NOW, false},
                {chain("leaf"), "polaris.local", PINS, NOW, false},
                {chain("ca"), "polaris.local", PINS, NOW, false},
                {chain("ca", "ca"), "polaris.local", PINS, NOW, false},
                {chain("leaf", "forged", "ca"), "polaris.local", PINS, NOW, false},
                {chain("leaf", "ca"), "polaris.local", PINS, new Date(1_735_689_600_000L), false}, // 2025, not yet
                {chain("leaf", "ca"), "polaris.local", PINS, new Date(1_893_456_000_000L), false}, // 2030, expired
                {new X509Certificate[0], "polaris.local", PINS, NOW, false},
        };
        for (int i = 0; i < table.length; i++) {
            Object[] row = table[i];
            @SuppressWarnings("unchecked")
            boolean accepted = PolarisLocalCa.chainEndsInPin((X509Certificate[]) row[0], (String) row[1],
                    (List<String>) row[2], (Date) row[3]);
            assertEquals("row " + i + " (" + row[1] + ")", row[4], accepted);
        }
    }

    /** A platform trust that refuses everything, as Android does for a CA it does not know. */
    private static final X509TrustManager REFUSES = new X509TrustManager() {
        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("refused");
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("refused");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    };

    private static PolarisLocalCa.Trust trust(String host) {
        return new PolarisLocalCa.Trust(REFUSES, host, PINS) {
            @Override
            Date now() {
                return NOW;
            }
        };
    }

    @Test
    public void trustFallsBackToThePinOnlyForAChainThatEndsInIt() throws CertificateException {
        trust("polaris.local").checkServerTrusted(chain("leaf", "ca"), "RSA");
        for (String[] refused : new String[][] {{"forged", "ca"}, {"expired", "ca"}, {"wronghost", "ca"}}) {
            try {
                trust("polaris.local").checkServerTrusted(chain(refused), "RSA");
                fail(refused[0] + " was trusted");
            } catch (CertificateException expected) {
                assertEquals("refused", expected.getMessage());
            }
        }
    }

    private static PolarisFailover.Instance instance(List<String> addresses, List<String> pins) {
        return new PolarisFailover.Instance("inst_12345", KEY, addresses, pins);
    }

    private static final String PRIMARY = "https://polaris.example.com";

    @Test
    public void scopeIsTheOtherHttpsHostsOfAnHttpsUsualAddress() {
        List<String> addresses = Arrays.asList(PRIMARY, "https://polaris.local", "http://192.168.1.50",
                "https://192.168.1.50:8443");
        PolarisLocalCa.Scope scope = PolarisLocalCa.scope(PRIMARY, instance(addresses, PINS));
        assertNotNull(scope);
        assertEquals(Arrays.asList("polaris.local", "192.168.1.50"), new ArrayList<>(scope.hosts));
        assertTrue(scope.covers("Polaris.Local"));
        assertFalse(scope.covers("polaris.example.com"));
        assertFalse(scope.covers("evil.local"));
        assertEquals(PINS, scope.pins);
    }

    @Test
    public void noScopeWithoutAPinAnHttpsUsualAddressOrAnHttpsAlternate() {
        List<String> addresses = Arrays.asList(PRIMARY, "https://polaris.local");
        assertNull(PolarisLocalCa.scope(PRIMARY, instance(addresses, Collections.emptyList())));
        assertNull(PolarisLocalCa.scope(PRIMARY, null));
        assertNull(PolarisLocalCa.scope("http://polaris.example.com",
                instance(Arrays.asList("http://polaris.example.com", "https://polaris.local"), PINS)));
        assertNull(PolarisLocalCa.scope(PRIMARY, instance(Arrays.asList(PRIMARY, "http://polaris.local"), PINS)));
    }

    private static final String RECORD = "{\"id\":\"inst_12345\",\"publicKey\":\"" + KEY
            + "\",\"addresses\":[\"https://polaris.example.com\",\"https://polaris.local\"]";

    @Test
    public void readsThePinsFromTheRecordAndToleratesTheirAbsence() {
        assertEquals(Collections.emptyList(), PolarisFailover.readInstance(RECORD + "}").localCaSha256);
        assertEquals(PINS, PolarisFailover.readInstance(
                RECORD + ",\"localCaSha256\":[\"" + CA_PIN.toUpperCase() + "\",\"nope\",42]}").localCaSha256);
        assertEquals(Collections.emptyList(),
                PolarisFailover.readInstance(RECORD + ",\"localCaSha256\":\"" + CA_PIN + "\"}").localCaSha256);
        StringBuilder many = new StringBuilder(RECORD + ",\"localCaSha256\":[");
        for (int i = 0; i < 6; i++) many.append(i == 0 ? "" : ",").append('"').append(i).append(CA_PIN.substring(1)).append('"');
        assertEquals(PolarisLocalCa.MAX_PINS, PolarisFailover.readInstance(many + "]}").localCaSha256.size());
    }

    /** The origins the failover tried, in order, when nothing answers. */
    private static List<String> tried(PolarisFailover.Instance instance) {
        List<String> urls = new ArrayList<>();
        PolarisFailover failover = new PolarisFailover((method, url, body, token) -> {
            urls.add(url);
            throw new IOException("down");
        }, PRIMARY, instance);
        try {
            failover.request("GET", "/api/tv/state", null, "token");
            fail("nothing answered");
        } catch (IOException expected) {
            // Every address was down.
        }
        return urls;
    }

    @Test
    public void withAPinTheTokenNeverGoesToAPlainAddress() {
        List<String> addresses = Arrays.asList(PRIMARY, "http://polaris.local", "https://polaris.local");
        assertEquals(Arrays.asList(PRIMARY + "/api/tv/state", "https://polaris.local" + PolarisFailover.CHALLENGE_PATH),
                tried(instance(addresses, PINS)));
        assertEquals(Arrays.asList(PRIMARY + "/api/tv/state", "http://polaris.local" + PolarisFailover.CHALLENGE_PATH,
                "https://polaris.local" + PolarisFailover.CHALLENGE_PATH),
                tried(instance(addresses, Collections.emptyList())));
    }
}
