package app.polaris.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.security.KeyPair;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Logins written the way the server stores them, opened, matched, and written back without losing a field. */
public class VaultItemsTest {
    private static VaultCrypto.Key key(int seed) {
        byte[] raw = new byte[64];
        for (int i = 0; i < 64; i++) raw[i] = (byte) (i + seed);
        return VaultCrypto.Key.of(raw);
    }

    private static JSONObject stored(JSONObject item, String id, String org) throws Exception {
        return item.put("id", id).put("organizationId", org == null ? JSONObject.NULL : org)
                .put("revisionDate", "2026-11-01T10:00:00.000Z").put("deletedDate", JSONObject.NULL)
                .put("notes", "2.keep|me|untouched");
    }

    @Test
    public void opensOwnAndSharedLoginsAndMatchesThem() throws Exception {
        VaultCrypto.Key mine = key(0);
        VaultCrypto.Key shared = key(7);
        KeyPair pair = VaultCrypto.generateRsa();
        String privateKey = VaultCrypto.encryptBytes(pair.getPrivate().getEncoded(), mine);
        String orgKey = VaultCrypto.encryptRsa(shared.bytes(), pair.getPublic());

        JSONArray ciphers = new JSONArray()
                .put(stored(VaultItems.newLogin("Bank", "ana", "pw1", "androidapp://com.example.bank", mine), "a", null))
                .put(stored(VaultItems.newLogin("Example", "ana@example.com", "pw2", "https://example.com", shared),
                        "b", "org-1"))
                .put(stored(VaultItems.newLogin("Gone", "x", "y", "https://example.com", mine), "c", null)
                        .put("deletedDate", "2026-11-02T00:00:00.000Z"));
        JSONObject sync = new JSONObject().put("ciphers", ciphers).put("profile", new JSONObject()
                .put("privateKey", privateKey)
                .put("organizations", new JSONArray().put(new JSONObject().put("id", "org-1").put("key", orgKey))));

        JSONObject trimmed = VaultItems.trim(sync);
        List<VaultItems.Login> logins = VaultItems.open(trimmed, null, mine);
        assertEquals(2, logins.size());
        assertEquals("Bank", logins.get(0).name);
        assertEquals("pw2", logins.get(1).password);

        List<VaultItems.Login> forSite = VaultItems.forCandidate(logins, "https://login.example.com");
        assertEquals(1, forSite.size());
        assertEquals("b", forSite.get(0).id);
        assertEquals("a", VaultItems.forCandidate(logins, "androidapp://com.example.bank").get(0).id);
        assertTrue(VaultItems.forCandidate(logins, "androidapp://com.other").isEmpty());
        assertNotNull(VaultItems.existing(logins, "https://example.com", "ANA@example.com "));
        assertNull(VaultItems.existing(logins, "https://example.com", "someone"));
    }

    @Test
    public void aNewPasswordKeepsEveryOtherFieldAndTheOldOneInHistory() throws Exception {
        VaultCrypto.Key mine = key(0);
        JSONObject sync = new JSONObject().put("ciphers", new JSONArray()
                .put(stored(VaultItems.newLogin("Site", "ana", "old", "https://site.test", mine), "a", null)));
        VaultItems.Login login = VaultItems.open(VaultItems.trim(sync), null, mine).get(0);

        JSONObject rewritten = VaultItems.withNewPassword(login, "new", mine);
        assertEquals("new", VaultCrypto.decrypt(rewritten.getJSONObject("login").getString("password"), mine));
        assertEquals("old", VaultCrypto.decrypt(
                rewritten.getJSONArray("passwordHistory").getJSONObject(0).getString("password"), mine));
        assertEquals("2.keep|me|untouched", rewritten.getString("notes"));
        assertEquals("2026-11-01T10:00:00.000Z", rewritten.getString("lastKnownRevisionDate"));

        JSONObject remembered = VaultItems.withUri(login, "androidapp://com.example.app", mine);
        JSONArray uris = remembered.getJSONObject("login").getJSONArray("uris");
        assertEquals(2, uris.length());
        assertEquals("androidapp://com.example.app", VaultCrypto.decrypt(uris.getJSONObject(1).getString("uri"), mine));
    }
}
