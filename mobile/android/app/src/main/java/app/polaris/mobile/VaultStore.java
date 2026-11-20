package app.polaris.mobile;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What this phone keeps of the Polaris Vault it is connected to, for autofill in other apps.
 *
 * The vault key - the one secret that opens every item - is never written as it is. It is sealed under a key in the
 * phone's own keystore that only works for a few minutes after the owner has proved who they are (unlocking the
 * phone, a fingerprint, the PIN), so a phone that is picked up locked, or a copy of this app's files, opens nothing.
 * The synced items are written exactly as the server sent them, still encrypted under the vault key. The tokens only
 * reach that encrypted copy.
 */
final class VaultStore {
    /** Seconds after the owner last proved who they are during which the vault key opens without asking again. */
    static final int UNLOCK_WINDOW_SECONDS = 300;

    private static final String FILE = "vault";
    private static final String ALIAS = "polaris-vault-autofill";
    private static final String SYNC_FILE = "vault-sync.json";

    private VaultStore() {
    }

    /** The key is sealed but the owner has to prove who they are before it opens. */
    static final class Locked extends Exception {
    }

    /** The phone's lock screen was removed or reset, and the sealed key went with it: connect again. */
    static final class Lost extends Exception {
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static boolean connected(Context context) {
        return prefs(context).getString("refresh", null) != null && prefs(context).getString("key", null) != null;
    }

    static String origin(Context context) {
        return prefs(context).getString("origin", null);
    }

    /** One stable name for this phone in the vault's device list, made once. */
    static synchronized String deviceId(Context context) {
        String id = prefs(context).getString("device", null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            prefs(context).edit().putString("device", id).apply();
        }
        return id;
    }

    static boolean deviceSecure(Context context) {
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        return keyguard != null && keyguard.isDeviceSecure();
    }

    /** Save a new connection: where, the tokens, and the vault key sealed to the keystore. */
    static void connect(Context context, String origin, VaultClient.Token token, VaultCrypto.Key key)
            throws Locked, GeneralSecurityException, IOException {
        String sealed = seal(key.bytes(), true);
        prefs(context).edit()
                .putString("origin", origin)
                .putString("key", sealed)
                .putString("privateKey", token.privateKey)
                .remove("lastSync")
                .apply();
        saveToken(context, token);
    }

    static void saveToken(Context context, VaultClient.Token token) {
        prefs(context).edit()
                .putString("access", token.accessToken)
                .putLong("accessUntil", token.expiresAt)
                .putString("refresh", token.refreshToken)
                .apply();
    }

    /** Forget everything: the tokens, the sealed key, the keystore key and the synced copy. */
    static void disconnect(Context context) {
        String device = prefs(context).getString("device", null);
        prefs(context).edit().clear().putString("device", device).apply();
        //noinspection ResultOfMethodCallIgnored
        syncFile(context).delete();
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(ALIAS);
        } catch (GeneralSecurityException | IOException ignored) {
            // Nothing to delete.
        }
    }

    /** The vault key, if the owner has proved who they are recently enough. */
    static VaultCrypto.Key key(Context context) throws Locked, Lost {
        String sealed = prefs(context).getString("key", null);
        if (sealed == null) throw new Lost();
        try {
            byte[] raw = unseal(sealed);
            try {
                return VaultCrypto.Key.of(raw);
            } finally {
                Arrays.fill(raw, (byte) 0);
            }
        } catch (UserNotAuthenticatedException e) {
            throw new Locked();
        } catch (KeyPermanentlyInvalidatedException e) {
            throw new Lost();
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new Lost();
        }
    }

    /** Whether the key opens right now without asking anything. */
    static boolean unlocked(Context context) {
        try {
            key(context);
            return true;
        } catch (Locked | Lost e) {
            return false;
        }
    }

    static void saveSync(Context context, JSONObject sync) throws IOException {
        File target = syncFile(context);
        File temp = new File(target.getParentFile(), SYNC_FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(sync.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!temp.renameTo(target)) throw new IOException("rename");
        prefs(context).edit().putLong("lastSync", System.currentTimeMillis()).apply();
    }

    static JSONObject readSync(Context context) {
        File file = syncFile(context);
        if (!file.exists()) return null;
        try {
            return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    static long lastSync(Context context) {
        return prefs(context).getLong("lastSync", 0);
    }

    private static File syncFile(Context context) {
        return new File(context.getNoBackupFilesDir(), SYNC_FILE);
    }

    private static SecretKey keystoreKey(boolean create) throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (create && store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
        if (!create) {
            KeyStore.Entry entry = store.getEntry(ALIAS, null);
            if (!(entry instanceof KeyStore.SecretKeyEntry)) throw new KeyPermanentlyInvalidatedException();
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                // A fingerprint added later is the owner's own; it should not throw the connection away.
                .setInvalidatedByBiometricEnrollment(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(UNLOCK_WINDOW_SECONDS,
                    KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        } else {
            setWindowLegacy(spec);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(spec.build());
        return generator.generateKey();
    }

    @SuppressWarnings("deprecation")
    private static void setWindowLegacy(KeyGenParameterSpec.Builder spec) {
        spec.setUserAuthenticationValidityDurationSeconds(UNLOCK_WINDOW_SECONDS);
    }

    private static String seal(byte[] data, boolean fresh) throws Locked, GeneralSecurityException, IOException {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keystoreKey(fresh));
            byte[] sealed = cipher.doFinal(data);
            byte[] iv = cipher.getIV();
            byte[] out = new byte[1 + iv.length + sealed.length];
            out[0] = (byte) iv.length;
            System.arraycopy(iv, 0, out, 1, iv.length);
            System.arraycopy(sealed, 0, out, 1 + iv.length, sealed.length);
            return Base64.getEncoder().encodeToString(out);
        } catch (UserNotAuthenticatedException e) {
            throw new Locked();
        }
    }

    private static byte[] unseal(String value) throws GeneralSecurityException {
        byte[] all = Base64.getDecoder().decode(value);
        int ivLength = all[0];
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        SecretKey key;
        try {
            key = keystoreKey(false);
        } catch (IOException e) {
            throw new GeneralSecurityException(e);
        }
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 1, ivLength));
        return cipher.doFinal(all, 1 + ivLength, all.length - 1 - ivLength);
    }
}
