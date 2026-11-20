package app.polaris.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.security.KeyPair;
import java.security.PrivateKey;
import java.util.Base64;
import org.junit.Test;

/**
 * The phone opens what the dashboard and the extension seal. The vectors below were produced by
 * `@polaris/vault-crypto` itself (encrypt, generateRsaKeyPair, encryptRsa) for a test key of bytes 0..63 and a
 * throwaway RSA pair made only for this test.
 */
public class VaultCryptoTest {
    private static final String JS_ENCRYPTED = "2.L+87xkRsGr/zo9TeH8RP7A==|QD98Bm3Wa4xe2SuYV+EzZm5FAtDhoT62NYA2NmDeztQ=|9bt6R7gyzXXoe1HW9d2MpOR2"
            + "UuWzFuObJItx5fbBFKs=";
    private static final String JS_PRIVATE_PKCS8 = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCumLkR42kYqKxEeOHFLISoGeUQSj5Yf5BFltY1iLqwvmbH"
            + "u/qI3WV5IMoA8T+xpNo56uPVXElAdlFP26w4g1H5IT3ShaGGqSxi0ABv9GZiTq8sVa6D/eGM3r5iVvf0yIqRKrTXLfk7wvsd"
            + "D5ECMDNd2IglGQ3kBNuvvEICC+djYW/ERDdbvL5EpsXQ4Gud/h0VGZ0Lm2QMH6F27T/yPpnI38LGtSzeOF2TQ81eEwZxWTM5"
            + "I7Pr4pN+PjcbQryYlXuMUi9oR6fkMas4vbZidj7MVnlbPfTxwWZsykW6CXOqM10pqdWE639zVwL4yjvrXgZt/tqhlMqe2ShP"
            + "AypxV8hrAgMBAAECggEAI77VyRFHf4ps9nnPM0iZgjcG/C5PFFxNg8nNYllza2MX9NWKBgJZ15I8eTPrJ+oJ2ai664BA6Qcw"
            + "P4rIeCt+mWRSXWsJdmHlWfee10zwtzjHyWpjV9efGXGzBbwreLykDfNx4coiSDdzpO/+brXClniR6xJ1kxThi1meJAAe5+wA"
            + "qOg4AAiIvjLr0I5Dn5/pBSiwvU/+CQt2p3PJFuulytAbVP15Of5BUJKNTi4D+BGWs8cUEglP5jwhewUzt+lvUZaY5vjNYquc"
            + "wgfCvEnKmGIxHT1L4eYjfOMgJ/Fmns3LEc5RbECCDV4VhM5l5Ebk/S7QrfW3zbvQUwZiJpjZVQKBgQDijUi8xWlBTLdUkTF+"
            + "fC02bKrJ04fmShD6ru0p3SPif2PM6wbmyC0Db5HJ0E9txALIILsY16Ed8symITE6Hkoe75H29ApvDyswaS4t45WQ0W7hIgs7"
            + "ABYxOQOwCpwUpgIxjKboepJ5kYri65IH6U6j091YUVJ0/vorraj6Aa49LwKBgQDFSpRRQ/9Gdpn0xi7jtXtMPHeahioTJnkV"
            + "QOYs6D5o5kDb0nz1YVUnz5N9KZcZmwoHNPSw2MIiCFZ9Adb/ZiJHcW6ststWvWekzVtMPc5pxG/D9vIyaw1zXOsrP6YG1haE"
            + "xS0RfZbwnFXrgjUbxg8YCaUmrb3LFEXwZNGE2qQxhQKBgQCsagG1SDf2bkAHqAgWzsJJ7SF9P/LpG+0YGxB7D8VDlteJGETE"
            + "VguL1dkJ0fLhAo9rZx18pn4DoMiGljQ0muCl8oUPgGKAavbffOycF9u3vuu3goUxfbtl8pIP48MtI7n/o59SxhW7VzxvvgAA"
            + "7Vnf7FlD4X/zcilKHHvA6I6GGQKBgQCmaSzHizJUTg+4Pj4oxdg1Sr+bsFTnCEmTmsVL1a1mr+i/QkEyfKHmTZlbNmyEJZkE"
            + "0S8fyAWfzSaelKGzlYOOfWhb+Gd1R5eXk7vRiESGRDH9uls6GcAjsZmPRkWVeJlP7j0Ahs19MHDskEyZm6r5nJEYGe5/0B7a"
            + "EUAE7qMWPQKBgGdE5yPPRlMPLS/dCxuV5duixzSsZ4ZPvYPIhyoqkRj0SyIlC5QJJNMng15d3wQITzxw1yZqqP6GYPKmmjRr"
            + "v8MqAS/SrjEqOdz4ycHxR1bonpu9yuWb1THrAV0P3rGHq/gctQDgJYPiLDyWXasQB/nXUvrrXKF7VjdNXGglJ1eE";
    private static final String JS_SEALED_KEY = "4.SvAbY7Ys+szkYnXWvb6hJf+dSP6KfQTh3mf0rqJBf5mmSTiVFUAgucFFtLmu5KPKvaM0gJPIitJqcGGmuFeRkCTtnECLR5"
            + "Ob+jfY71nNx4vw+uPBNTFAqsk9H7JTA1q5u8YQdDVtiH1/385RFh/YWxABzhlsdUYXM03NwPw0qd//9StIHhrk4vjyZg2/C5"
            + "johrFETeyrEWXJ4Qe/P8H3ONoGP1ll2Dw3UBAf6n2mM9++9FMfhJ49QQ3bSBIIoAF1R1SX8G1SwoFXmP2QFMw4vFAwRxONJj"
            + "rgY3F+I456deQceKf0uySYWM7naNzjdSkajKBDucqW1zvkVhYo0CR8Ug==";

    private static byte[] testKeyBytes() {
        byte[] raw = new byte[64];
        for (int i = 0; i < 64; i++) raw[i] = (byte) i;
        return raw;
    }

    @Test
    public void opensWhatTheDashboardEncrypted() {
        VaultCrypto.Key key = VaultCrypto.Key.of(testKeyBytes());
        assertEquals("hunter2 \u00f1 polaris", VaultCrypto.decrypt(JS_ENCRYPTED, key));
    }

    @Test
    public void opensAKeySealedToItsPairByTheServer() throws Exception {
        PrivateKey key = VaultCrypto.privateKeyFromPkcs8(Base64.getDecoder().decode(JS_PRIVATE_PKCS8));
        assertArrayEquals(testKeyBytes(), VaultCrypto.decryptRsa(JS_SEALED_KEY, key));
    }

    @Test
    public void refusesATamperedValueOrTheWrongKey() {
        VaultCrypto.Key key = VaultCrypto.Key.of(testKeyBytes());
        byte[] other = testKeyBytes();
        other[40] ^= 1;
        assertNull(VaultCrypto.decrypt(JS_ENCRYPTED, VaultCrypto.Key.of(other)));
        String[] parts = JS_ENCRYPTED.split("\\|");
        String tampered = parts[0] + "|" + (parts[1].startsWith("A") ? "B" : "A") + parts[1].substring(1) + "|" + parts[2];
        assertNull(VaultCrypto.decrypt(tampered, key));
        assertNull(VaultCrypto.decrypt("0.abc", key));
        assertNull(VaultCrypto.decrypt("not encrypted", key));
    }

    @Test
    public void roundTripsWhatItEncrypts() throws Exception {
        VaultCrypto.Key key = VaultCrypto.Key.of(testKeyBytes());
        String sealed = VaultCrypto.encrypt("correct horse", key);
        assertEquals("correct horse", VaultCrypto.decrypt(sealed, key));
        KeyPair pair = VaultCrypto.generateRsa();
        String wrapped = VaultCrypto.encryptRsa(testKeyBytes(), pair.getPublic());
        assertArrayEquals(testKeyBytes(), VaultCrypto.decryptRsa(wrapped, pair.getPrivate()));
    }
}
