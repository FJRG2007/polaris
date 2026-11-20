package app.polaris.mobile;

import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The vault's logins, opened: what a sync brought back, decrypted with the account's key and each shared vault's,
 * matched against what is asking to be filled, and new or changed logins written back in the shape
 * `cipherSchema` (`packages/core/src/schemas/vault.ts`) validates.
 *
 * Plain JVM (org.json only), so it is tested against items sealed exactly the way the dashboard seals them.
 */
final class VaultItems {
    static final int TYPE_LOGIN = 1;

    private VaultItems() {
    }

    static final class SavedUri {
        final String uri;
        final Integer match;

        SavedUri(String uri, Integer match) {
            this.uri = uri;
            this.match = match;
        }
    }

    static final class Login {
        final String id;
        final String organizationId;
        final String name;
        final String username;
        final String password;
        final List<SavedUri> uris;
        final JSONObject raw;

        Login(String id, String organizationId, String name, String username, String password, List<SavedUri> uris,
                JSONObject raw) {
            this.id = id;
            this.organizationId = organizationId;
            this.name = name;
            this.username = username;
            this.password = password;
            this.uris = uris;
            this.raw = raw;
        }

        boolean matches(String candidate) {
            for (SavedUri saved : uris) {
                if (VaultUris.matches(saved.uri, saved.match, candidate)) return true;
            }
            return false;
        }

        /** Whether one of its addresses names exactly the candidate's host or app, for ranking. */
        boolean close(String candidate) {
            String host = VaultUris.hostOf(candidate);
            for (SavedUri saved : uris) {
                if (saved.uri.equalsIgnoreCase(candidate)) return true;
                if (host != null && host.equals(VaultUris.hostOf(saved.uri))) return true;
            }
            return false;
        }
    }

    /** Keep only what autofill reads: live logins, the vaults' sealed keys and the account's private key. */
    static JSONObject trim(JSONObject sync) {
        JSONObject out = new JSONObject();
        try {
            JSONArray ciphers = new JSONArray();
            JSONArray all = sync.optJSONArray("ciphers");
            for (int i = 0; all != null && i < all.length(); i++) {
                JSONObject cipher = all.optJSONObject(i);
                if (cipher == null || cipher.optInt("type") != TYPE_LOGIN) continue;
                if (!cipher.isNull("deletedDate") && !cipher.optString("deletedDate").isEmpty()) continue;
                ciphers.put(cipher);
            }
            out.put("ciphers", ciphers);
            JSONObject profile = sync.optJSONObject("profile");
            JSONArray organizations = new JSONArray();
            if (profile != null) {
                JSONArray held = profile.optJSONArray("organizations");
                for (int i = 0; held != null && i < held.length(); i++) {
                    JSONObject org = held.optJSONObject(i);
                    if (org == null) continue;
                    organizations.put(new JSONObject().put("id", org.optString("id")).put("key", org.optString("key"))
                            .put("name", org.optString("name")));
                }
                out.put("privateKey", profile.optString("privateKey", ""));
                out.put("email", profile.optString("email", ""));
            }
            out.put("organizations", organizations);
        } catch (JSONException ignored) {
            // Only puts with valid names above.
        }
        return out;
    }

    /** Each shared vault's key, unwrapped with the account's private half. A vault not yet let into is skipped. */
    static Map<String, VaultCrypto.Key> organizationKeys(JSONObject sync, String privateKey, VaultCrypto.Key key) {
        Map<String, VaultCrypto.Key> keys = new HashMap<>();
        String sealedPrivate = privateKey != null && !privateKey.isEmpty() ? privateKey : sync.optString("privateKey");
        byte[] pkcs8 = VaultCrypto.decryptBytes(sealedPrivate, key);
        if (pkcs8 == null) return keys;
        PrivateKey opened;
        try {
            opened = VaultCrypto.privateKeyFromPkcs8(pkcs8);
        } catch (GeneralSecurityException e) {
            return keys;
        }
        JSONArray organizations = sync.optJSONArray("organizations");
        for (int i = 0; organizations != null && i < organizations.length(); i++) {
            JSONObject org = organizations.optJSONObject(i);
            if (org == null) continue;
            byte[] raw = VaultCrypto.decryptRsa(org.optString("key"), opened);
            if (raw != null && raw.length == 64) keys.put(org.optString("id"), VaultCrypto.Key.of(raw));
        }
        return keys;
    }

    static String text(JSONObject object, String field, VaultCrypto.Key key) {
        if (object == null || object.isNull(field)) return null;
        String value = object.optString(field, "");
        return value.isEmpty() ? null : VaultCrypto.decrypt(value, key);
    }

    /** Every login that opens, sorted by name. One that will not open is left out rather than shown blank. */
    static List<Login> open(JSONObject sync, String privateKey, VaultCrypto.Key key) {
        List<Login> logins = new ArrayList<>();
        if (sync == null) return logins;
        Map<String, VaultCrypto.Key> organizations = organizationKeys(sync, privateKey, key);
        JSONArray ciphers = sync.optJSONArray("ciphers");
        for (int i = 0; ciphers != null && i < ciphers.length(); i++) {
            JSONObject cipher = ciphers.optJSONObject(i);
            if (cipher == null) continue;
            String org = cipher.isNull("organizationId") ? null : cipher.optString("organizationId", null);
            VaultCrypto.Key itemKey = org == null ? key : organizations.get(org);
            if (itemKey == null) continue;
            String name = text(cipher, "name", itemKey);
            if (name == null) continue;
            JSONObject login = cipher.optJSONObject("login");
            List<SavedUri> uris = new ArrayList<>();
            JSONArray saved = login == null ? null : login.optJSONArray("uris");
            for (int j = 0; saved != null && j < saved.length(); j++) {
                JSONObject entry = saved.optJSONObject(j);
                String uri = text(entry, "uri", itemKey);
                if (uri == null) continue;
                Integer match = entry.isNull("match") || !entry.has("match") ? null : entry.optInt("match");
                uris.add(new SavedUri(uri, match));
            }
            logins.add(new Login(cipher.optString("id"), org, name, text(login, "username", itemKey),
                    text(login, "password", itemKey), uris, cipher));
        }
        Collections.sort(logins, (a, b) -> a.name.compareToIgnoreCase(b.name));
        return logins;
    }

    /** The logins offered for an address or an app, the ones naming it exactly first. */
    static List<Login> forCandidate(List<Login> logins, String candidate) {
        List<Login> close = new ArrayList<>();
        List<Login> rest = new ArrayList<>();
        if (candidate == null) return close;
        for (Login login : logins) {
            if (!login.matches(candidate)) continue;
            (login.close(candidate) ? close : rest).add(login);
        }
        close.addAll(rest);
        return close;
    }

    /** The login a save would change rather than duplicate: same address and same username. */
    static Login existing(List<Login> logins, String candidate, String username) {
        String wanted = username == null ? "" : username.trim().toLowerCase(Locale.ROOT);
        for (Login login : forCandidate(logins, candidate)) {
            String held = login.username == null ? "" : login.username.trim().toLowerCase(Locale.ROOT);
            if (held.equals(wanted)) return login;
        }
        return null;
    }

    /** A new login for the account's own vault, every valuable field encrypted. */
    static JSONObject newLogin(String name, String username, String password, String uri, VaultCrypto.Key key)
            throws GeneralSecurityException, JSONException {
        JSONObject login = new JSONObject()
                .put("username", username == null || username.isEmpty() ? JSONObject.NULL
                        : VaultCrypto.encrypt(username, key))
                .put("password", password == null || password.isEmpty() ? JSONObject.NULL
                        : VaultCrypto.encrypt(password, key));
        if (uri != null) {
            login.put("uris", new JSONArray().put(new JSONObject().put("uri", VaultCrypto.encrypt(uri, key))
                    .put("match", JSONObject.NULL)));
        }
        return new JSONObject().put("type", TYPE_LOGIN).put("name", VaultCrypto.encrypt(name, key)).put("login", login);
    }

    /**
     * The same item with a new password, sent back whole: there is no endpoint for one field, and every field this
     * app does not read travels back untouched (as `withNewPassword` in the extension does). The old password goes to
     * the history, and the revision it was read at makes a stale write a 409 instead of an overwrite.
     */
    static JSONObject withNewPassword(Login held, String password, VaultCrypto.Key key)
            throws GeneralSecurityException, JSONException {
        JSONObject item = new JSONObject(held.raw.toString());
        JSONObject login = item.optJSONObject("login");
        if (login == null) login = new JSONObject();
        String now = Instant.now().toString();
        Object replaced = login.opt("password");
        JSONArray history = item.optJSONArray("passwordHistory");
        JSONArray next = new JSONArray();
        if (replaced instanceof String && !((String) replaced).isEmpty()) {
            next.put(new JSONObject().put("password", replaced).put("lastUsedDate", now));
        }
        for (int i = 0; history != null && i < history.length(); i++) next.put(history.get(i));
        login.put("password", VaultCrypto.encrypt(password, key)).put("passwordRevisionDate", now);
        item.put("login", login).put("passwordHistory", next);
        String revision = held.raw.optString("revisionDate", "");
        if (!revision.isEmpty()) item.put("lastKnownRevisionDate", revision);
        return item;
    }

    /** The item with one more address, so the app it was picked for finds it next time. */
    static JSONObject withUri(Login held, String uri, VaultCrypto.Key key) throws GeneralSecurityException, JSONException {
        JSONObject item = new JSONObject(held.raw.toString());
        JSONObject login = item.optJSONObject("login");
        if (login == null) login = new JSONObject();
        JSONArray uris = login.optJSONArray("uris");
        if (uris == null) uris = new JSONArray();
        uris.put(new JSONObject().put("uri", VaultCrypto.encrypt(uri, key)).put("match", JSONObject.NULL));
        login.put("uris", uris);
        item.put("login", login);
        String revision = held.raw.optString("revisionDate", "");
        if (!revision.isEmpty()) item.put("lastKnownRevisionDate", revision);
        return item;
    }
}
