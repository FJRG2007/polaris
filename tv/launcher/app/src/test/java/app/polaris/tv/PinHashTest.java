package app.polaris.tv;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class PinHashTest {
    private static byte[] salt() {
        byte[] salt = new byte[16];
        for (int i = 0; i < salt.length; i++) salt[i] = (byte) i;
        return salt;
    }

    /** Stands in for the Keystore key: a plain HMAC with a fixed test key. */
    private static PinHash.Binder fakeMac(String key) {
        return derived -> {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(derived);
        };
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format("%02x", b & 0xff));
        return out.toString();
    }

    @Test
    public void pbkdf2MatchesAKnownOutput() throws Exception {
        // Python: hashlib.pbkdf2_hmac('sha256', b'1234', bytes(range(16)), 100000, 32).hex()
        assertEquals("869e6c8350c5beb0acc399fbaac3b60d220433896b26a647734d0d8f1586e1fa",
                hex(PinHash.pbkdf2("1234", salt(), 100_000)));
    }

    @Test
    public void theRightPinMatchesAndAWrongOneDoesNot() throws Exception {
        PinHash.Record record = PinHash.create("4821", 100_000, salt(), fakeMac("tv"));
        assertTrue(PinHash.matches(record, "4821", fakeMac("tv")));
        assertFalse(PinHash.matches(record, "4822", fakeMac("tv")));
        assertFalse(PinHash.matches(record, "48210", fakeMac("tv")));
        assertFalse(PinHash.matches(record, "", fakeMac("tv")));
        // The same PIN with another TV's key: a copied record is useless elsewhere.
        assertFalse(PinHash.matches(record, "4821", fakeMac("another tv")));
    }

    @Test
    public void iterationsNeverGoBelowTheFloor() throws Exception {
        PinHash.Record record = PinHash.create("123456", 10, salt(), fakeMac("tv"));
        assertEquals(PinHash.MIN_ITERATIONS, record.iters);
        assertEquals(PinHash.MIN_ITERATIONS, PinHash.iterationsFor(20_000, 1_000));
        assertEquals(PinHash.MAX_ITERATIONS, PinHash.iterationsFor(20_000, 0));
        assertEquals(PinHash.MAX_ITERATIONS, PinHash.iterationsFor(20_000, 1));
        assertEquals(500_000, PinHash.iterationsFor(20_000, 10));
    }

    @Test
    public void onlyFourToSixDigitsArePins() {
        assertTrue(PinHash.valid("0000"));
        assertTrue(PinHash.valid("999999"));
        assertFalse(PinHash.valid("123"));
        assertFalse(PinHash.valid("1234567"));
        assertFalse(PinHash.valid("12a4"));
        assertFalse(PinHash.valid("١٢٣٤"));   // Arabic-Indic digits are not typed by the pad
        assertFalse(PinHash.valid(null));
    }

    @Test
    public void theRecordSurvivesAnEncodeAndDecode() throws Exception {
        PinHash.Record record = PinHash.create("0420", 120_000, salt(), fakeMac("tv"))
                .withLockout(new PinLockout.State(6, 1_700_000_060_000L, 1_700_000_000_000L));
        PinHash.Record back = PinHash.decode(PinHash.encode(record));
        assertNotNull(back);
        assertEquals(120_000, back.iters);
        assertEquals(4, back.len);
        assertArrayEquals(record.salt, back.salt);
        assertArrayEquals(record.mac, back.mac);
        assertEquals(6, back.lockout.fails);
        assertEquals(1_700_000_060_000L, back.lockout.lockedUntil);
        assertEquals(1_700_000_000_000L, back.lockout.lastWall);
        assertTrue(PinHash.matches(back, "0420", fakeMac("tv")));
    }

    @Test
    public void unreadableRecordsAreNone() {
        assertNull(PinHash.decode(null));
        assertNull(PinHash.decode(""));
        assertNull(PinHash.decode("not json"));
        assertNull(PinHash.decode("{\"v\":2,\"iters\":100000,\"salt\":\"AAAAAAAAAAAAAAAAAAAAAA==\"}"));
        assertNull(PinHash.decode("{\"v\":1,\"iters\":100000,\"salt\":\"AA==\",\"mac\":\"AA==\",\"len\":4}"));
    }
}
