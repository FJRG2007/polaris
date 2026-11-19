package app.polaris.mobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/**
 * This phone's own key, made once in the Android keystore and never readable outside it. What it signs proves a
 * request came from this app on this phone: a photo sent to be seen once is handed only to a request signed here,
 * never to a browser tab.
 */
final class DeviceKey {
    private static final String STORE = "AndroidKeyStore";
    private static final String ALIAS = "polaris-device-key";

    private DeviceKey() {}

    private static KeyStore store() throws GeneralSecurityException {
        try {
            KeyStore store = KeyStore.getInstance(STORE);
            store.load(null);
            return store;
        } catch (java.io.IOException failed) {
            throw new GeneralSecurityException(failed);
        }
    }

    private static synchronized void ensure() throws GeneralSecurityException {
        if (store().containsAlias(ALIAS)) return;
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE);
        generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build());
        generator.generateKeyPair();
    }

    /** The public half, as X.509 SubjectPublicKeyInfo in base64: what the instance keeps to check signatures. */
    static String publicKey() throws GeneralSecurityException {
        ensure();
        PublicKey key = store().getCertificate(ALIAS).getPublicKey();
        return Base64.encodeToString(key.getEncoded(), Base64.NO_WRAP);
    }

    /** An ECDSA P-256 signature over the text, DER-encoded, in base64. */
    static String sign(String text) throws GeneralSecurityException {
        ensure();
        PrivateKey key = (PrivateKey) store().getKey(ALIAS, null);
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign(key);
        signature.update(text.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP);
    }
}
