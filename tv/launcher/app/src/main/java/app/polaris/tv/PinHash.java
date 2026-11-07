package app.polaris.tv;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * A profile's PIN, checked only on this TV. The check value is
 * {@code HMAC_keystore(PBKDF2WithHmacSHA256(pin, salt, iters, 256))}: the PBKDF2 half and the record are pure and
 * tested off the TV with a stand-in MAC; {@link #keystore()} binds the result to a key that never leaves this
 * TV's Keystore, so a check value copied off the TV cannot be guessed against elsewhere. Every hash is slow on
 * purpose: call {@link #create} and {@link #matches} off the main thread. The PIN itself is never stored or logged.
 */
final class PinHash {
    static final int MIN_LENGTH = 4;
    static final int MAX_LENGTH = 6;
    /** Never fewer PBKDF2 rounds than this, however slow the TV. */
    static final int MIN_ITERATIONS = 100_000;
    /** And never more than this, so a fast TV still opens a profile in about a second at most. */
    static final int MAX_ITERATIONS = 2_000_000;
    static final long TARGET_MS = 250;
    static final int SALT_BYTES = 16;
    static final String KEY_ALIAS = "polaris-tv-pin";

    /** The second half of the check value: on the TV the Keystore's HMAC, in tests a stand-in. */
    interface Binder {
        byte[] mac(byte[] derived) throws GeneralSecurityException;
    }

    private PinHash() {
    }

    /** The stored PIN: {@code {v:1, iters, salt, mac, len, fails, lockedUntil, lastWall}}. */
    static final class Record {
        final int iters;
        final byte[] salt;
        final byte[] mac;
        final int len;
        final PinLockout.State lockout;

        Record(int iters, byte[] salt, byte[] mac, int len, PinLockout.State lockout) {
            this.iters = iters;
            this.salt = salt;
            this.mac = mac;
            this.len = len;
            this.lockout = lockout == null ? PinLockout.State.NONE : lockout;
        }

        Record withLockout(PinLockout.State state) {
            return new Record(iters, salt, mac, len, state);
        }
    }

    // ---- Pure ----

    /** Whether {@code pin} can be a PIN: 4 to 6 ASCII digits. */
    static boolean valid(String pin) {
        if (pin == null || pin.length() < MIN_LENGTH || pin.length() > MAX_LENGTH) return false;
        for (int i = 0; i < pin.length(); i++) {
            char c = pin.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    static byte[] pbkdf2(String pin, byte[] salt, int iters) throws GeneralSecurityException {
        char[] chars = pin.toCharArray();
        PBEKeySpec spec = new PBEKeySpec(chars, salt, iters, 256);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } finally {
            spec.clearPassword();
            Arrays.fill(chars, '\0');
        }
    }

    /** Rounds for about {@link #TARGET_MS} given that {@code sampleIters} took {@code sampleMs}, within the bounds. */
    static int iterationsFor(int sampleIters, long sampleMs) {
        long scaled = sampleMs <= 0 ? MAX_ITERATIONS : sampleIters * TARGET_MS / sampleMs;
        return (int) Math.max(MIN_ITERATIONS, Math.min(MAX_ITERATIONS, scaled));
    }

    static byte[] checkValue(String pin, byte[] salt, int iters, Binder binder) throws GeneralSecurityException {
        byte[] derived = pbkdf2(pin, salt, iters);
        try {
            return binder.mac(derived);
        } finally {
            Arrays.fill(derived, (byte) 0);
        }
    }

    /** A new record for {@code pin}; the rounds are raised to the floor if asked for fewer. */
    static Record create(String pin, int iters, byte[] salt, Binder binder) throws GeneralSecurityException {
        if (!valid(pin)) throw new IllegalArgumentException("not a PIN");
        int rounds = Math.max(MIN_ITERATIONS, iters);
        return new Record(rounds, salt.clone(), checkValue(pin, salt, rounds, binder), pin.length(),
                PinLockout.State.NONE);
    }

    static boolean matches(Record record, String pin, Binder binder) throws GeneralSecurityException {
        if (record == null || !valid(pin) || pin.length() != record.len) return false;
        return MessageDigest.isEqual(record.mac, checkValue(pin, record.salt, record.iters, binder));
    }

    static String encode(Record r) {
        Base64.Encoder b64 = Base64.getEncoder();
        try {
            return new JSONObject().put("v", 1).put("iters", r.iters).put("salt", b64.encodeToString(r.salt))
                    .put("mac", b64.encodeToString(r.mac)).put("len", r.len).put("fails", r.lockout.fails)
                    .put("lockedUntil", r.lockout.lockedUntil).put("lastWall", r.lockout.lastWall).toString();
        } catch (JSONException cannotHappen) {
            throw new IllegalStateException(cannotHappen);
        }
    }

    /** The stored record, or null for none or anything unreadable (an unknown version included). */
    static Record decode(String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(json);
            if (o.optInt("v", 0) != 1) return null;
            Base64.Decoder b64 = Base64.getDecoder();
            byte[] salt = b64.decode(o.getString("salt"));
            byte[] mac = b64.decode(o.getString("mac"));
            int iters = o.getInt("iters");
            int len = o.getInt("len");
            if (salt.length != SALT_BYTES || mac.length != 32 || iters < MIN_ITERATIONS
                    || len < MIN_LENGTH || len > MAX_LENGTH) return null;
            PinLockout.State lockout = new PinLockout.State(Math.max(0, o.optInt("fails", 0)),
                    o.optLong("lockedUntil", 0L), o.optLong("lastWall", 0L));
            return new Record(iters, salt, mac, len, lockout);
        } catch (JSONException | IllegalArgumentException malformed) {
            return null;
        }
    }

    // ---- On the TV ----

    static byte[] newSalt() {
        byte[] salt = new byte[SALT_BYTES];
        new SecureRandom().nextBytes(salt);
        return salt;
    }

    /** Times PBKDF2 on this TV once; the caller keeps the answer so later PINs skip it. */
    static int tune() throws GeneralSecurityException {
        int sample = 20_000;
        byte[] salt = newSalt();
        pbkdf2("0000", salt, 2_000);   // warm-up, so class loading does not count
        long start = System.nanoTime();
        pbkdf2("0000", salt, sample);
        return iterationsFor(sample, (System.nanoTime() - start) / 1_000_000L);
    }

    /** HMAC-SHA256 with the TV's {@link #KEY_ALIAS} key, created (sign only, not exportable) on first use. */
    static Binder keystore() {
        return derived -> {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(keystoreKey());
            return mac.doFinal(derived);
        };
    }

    private static synchronized Key keystoreKey() throws GeneralSecurityException {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            Key key = store.getKey(KEY_ALIAS, null);
            if (key != null) return key;
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256,
                    "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN).build());
            return generator.generateKey();
        } catch (java.io.IOException e) {
            throw new GeneralSecurityException(e);
        }
    }
}
