package app.polaris.mobile;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import javax.crypto.spec.SecretKeySpec;

/**
 * The vault's encrypted strings, read and written the way `@polaris/vault-crypto` does on the dashboard and in the
 * extension: type 2 (AES-256-CBC with an HMAC-SHA256 over iv + ciphertext) for everything under a vault key, and
 * types 3/4 (RSA-OAEP, SHA-256 or SHA-1) for a key sealed to a public half.
 *
 * Plain JVM on purpose, so the unit tests run it against values the JavaScript side produced. Every failure is null:
 * a field that will not open is not something the reader can act on, and each distinction is a hint to an attacker.
 */
public final class VaultCrypto {
    static final int AES_CBC256_HMAC_SHA256 = 2;
    static final int RSA_OAEP_SHA256 = 3;
    static final int RSA_OAEP_SHA1 = 4;

    private static final SecureRandom RANDOM = new SecureRandom();

    private VaultCrypto() {
    }

    /** A vault key: 32 bytes for AES, 32 for the MAC. */
    public static final class Key {
        final byte[] enc;
        final byte[] mac;

        private Key(byte[] bytes) {
            if (bytes == null || bytes.length != 64) throw new IllegalArgumentException("A vault key is 64 bytes");
            enc = Arrays.copyOfRange(bytes, 0, 32);
            mac = Arrays.copyOfRange(bytes, 32, 64);
        }

        public static Key of(byte[] bytes) {
            return new Key(bytes);
        }

        public byte[] bytes() {
            byte[] out = new byte[64];
            System.arraycopy(enc, 0, out, 0, 32);
            System.arraycopy(mac, 0, out, 32, 32);
            return out;
        }
    }

    /** A fresh RSA-2048 pair; the public half goes to the server as base64 SPKI and the key comes back sealed to it. */
    public static KeyPair generateRsa() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048, RANDOM);
        return generator.generateKeyPair();
    }

    public static String publicKeyBase64(PublicKey key) {
        return Base64.getEncoder().encodeToString(key.getEncoded());
    }

    public static PrivateKey privateKeyFromPkcs8(byte[] pkcs8) throws GeneralSecurityException {
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
    }

    /** Decrypt a type-2 string to bytes, or null. The MAC is checked before anything is decrypted. */
    public static byte[] decryptBytes(String value, Key key) {
        if (value == null || key == null) return null;
        int dot = value.indexOf('.');
        if (dot <= 0) return null;
        try {
            if (Integer.parseInt(value.substring(0, dot)) != AES_CBC256_HMAC_SHA256) return null;
            String[] parts = value.substring(dot + 1).split("\\|");
            if (parts.length != 3) return null;
            byte[] iv = Base64.getDecoder().decode(parts[0]);
            byte[] data = Base64.getDecoder().decode(parts[1]);
            byte[] mac = Base64.getDecoder().decode(parts[2]);
            if (!MessageDigest.isEqual(hmac(key.mac, iv, data), mac)) return null;
            Cipher aes = Cipher.getInstance("AES/CBC/PKCS5Padding");
            aes.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key.enc, "AES"), new IvParameterSpec(iv));
            return aes.doFinal(data);
        } catch (IllegalArgumentException | GeneralSecurityException e) {
            return null;
        }
    }

    public static String decrypt(String value, Key key) {
        byte[] bytes = decryptBytes(value, key);
        return bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
    }

    public static String encryptBytes(byte[] data, Key key) throws GeneralSecurityException {
        byte[] iv = new byte[16];
        RANDOM.nextBytes(iv);
        Cipher aes = Cipher.getInstance("AES/CBC/PKCS5Padding");
        aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key.enc, "AES"), new IvParameterSpec(iv));
        byte[] sealed = aes.doFinal(data);
        Base64.Encoder b64 = Base64.getEncoder();
        return AES_CBC256_HMAC_SHA256 + "." + b64.encodeToString(iv) + "|" + b64.encodeToString(sealed) + "|"
                + b64.encodeToString(hmac(key.mac, iv, sealed));
    }

    public static String encrypt(String value, Key key) throws GeneralSecurityException {
        return encryptBytes(value.getBytes(StandardCharsets.UTF_8), key);
    }

    /** Open a type-3 or type-4 string sealed to this private key, or null. */
    public static byte[] decryptRsa(String value, PrivateKey key) {
        if (value == null || key == null) return null;
        int dot = value.indexOf('.');
        if (dot <= 0) return null;
        try {
            int type = Integer.parseInt(value.substring(0, dot));
            if (type != RSA_OAEP_SHA1 && type != RSA_OAEP_SHA256) return null;
            String data = value.substring(dot + 1).split("\\|")[0];
            // Spelled out: Android's "OAEPWithSHA-256AndMGF1Padding" keeps MGF1 on SHA-1, and WebCrypto does not.
            boolean sha1 = type == RSA_OAEP_SHA1;
            Cipher rsa = Cipher.getInstance("RSA/ECB/OAEPPadding");
            rsa.init(Cipher.DECRYPT_MODE, key, new OAEPParameterSpec(sha1 ? "SHA-1" : "SHA-256", "MGF1",
                    sha1 ? MGF1ParameterSpec.SHA1 : MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT));
            return rsa.doFinal(Base64.getDecoder().decode(data));
        } catch (IllegalArgumentException | GeneralSecurityException e) {
            return null;
        }
    }

    /** Seal bytes to a public half as type 4, as the server does. The tests play the server with it. */
    static String encryptRsa(byte[] data, PublicKey key) throws GeneralSecurityException {
        Cipher rsa = Cipher.getInstance("RSA/ECB/OAEPPadding");
        rsa.init(Cipher.ENCRYPT_MODE, key,
                new OAEPParameterSpec("SHA-1", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT));
        return RSA_OAEP_SHA1 + "." + Base64.getEncoder().encodeToString(rsa.doFinal(data));
    }

    private static byte[] hmac(byte[] key, byte[] iv, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        mac.update(iv);
        return mac.doFinal(data);
    }
}
