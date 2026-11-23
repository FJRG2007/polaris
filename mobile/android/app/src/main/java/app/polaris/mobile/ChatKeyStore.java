package app.polaris.mobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.webkit.JavascriptInterface;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Base64;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The page's `window.PolarisKeyStore`: the chat account key's device lock sealed by an AES-256-GCM key that lives in
 * the Android Keystore and never leaves it (docs/chat-e2ee-phase1.md, "Native key stores"). A copy of the app's
 * WebView data then opens nothing on another phone.
 *
 * Silent by design - no unlock prompt, the account key must open as the page loads - so the key is not tied to the
 * screen lock; it is tied to this install. Each sealed value is bound to the server it was sealed for (the origin is
 * the GCM associated data). Every failure answers "" (a JavaScript interface cannot return null portably), which the
 * page reads as "no device copy" and recovers from the password, a passkey or another device.
 */
final class ChatKeyStore {
    private static final String STORE = "AndroidKeyStore";
    private static final String ALIAS = "polaris-chat-key-wrap";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final Pattern TEXT = Pattern.compile("^[A-Za-z0-9_-]{1,4096}$");

    private final byte[] origin;

    ChatKeyStore(String origin) {
        this.origin = origin.getBytes(StandardCharsets.UTF_8);
    }

    private static synchronized SecretKey key() throws GeneralSecurityException {
        try {
            KeyStore store = KeyStore.getInstance(STORE);
            store.load(null);
            KeyStore.Entry entry = store.getEntry(ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        } catch (java.io.IOException failed) {
            throw new GeneralSecurityException(failed);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    @JavascriptInterface
    public String seal(String data) {
        if (data == null || !TEXT.matcher(data).matches()) return "";
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            // The keystore picks the IV (randomized encryption is required), never the page.
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(origin);
            byte[] sealed = cipher.doFinal(Base64.getUrlDecoder().decode(data));
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != IV_BYTES) return "";
            byte[] out = new byte[IV_BYTES + sealed.length];
            System.arraycopy(iv, 0, out, 0, IV_BYTES);
            System.arraycopy(sealed, 0, out, IV_BYTES, sealed.length);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(out);
        } catch (GeneralSecurityException | IllegalArgumentException failed) {
            return "";
        }
    }

    @JavascriptInterface
    public String open(String sealed) {
        if (sealed == null || !TEXT.matcher(sealed).matches()) return "";
        try {
            byte[] raw = Base64.getUrlDecoder().decode(sealed);
            if (raw.length <= IV_BYTES + TAG_BITS / 8) return "";
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES));
            cipher.updateAAD(origin);
            byte[] plain = cipher.doFinal(raw, IV_BYTES, raw.length - IV_BYTES);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(plain);
        } catch (GeneralSecurityException | IllegalArgumentException failed) {
            return "";
        }
    }
}
