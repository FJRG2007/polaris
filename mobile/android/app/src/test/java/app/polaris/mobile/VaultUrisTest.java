package app.polaris.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The same answers as `uriMatches` in packages/core/src/vault-uris.ts, plus apps by package. */
public class VaultUrisTest {
    @Test
    public void domainCoversTheSiteAndItsSubdomains() {
        assertTrue(VaultUris.matches("https://example.com/login", null, "https://accounts.example.com"));
        assertTrue(VaultUris.matches("example.co.uk", VaultUris.MATCH_DOMAIN, "https://www.example.co.uk/x"));
        assertFalse(VaultUris.matches("https://example.com", null, "https://example.com.evil.net"));
        assertFalse(VaultUris.matches("https://example.com", null, "https://notexample.com"));
    }

    @Test
    public void hostExactStartsWithRegexAndNever() {
        assertTrue(VaultUris.matches("https://a.example.com", VaultUris.MATCH_HOST, "https://a.example.com/p"));
        assertFalse(VaultUris.matches("https://a.example.com", VaultUris.MATCH_HOST, "https://b.example.com"));
        assertTrue(VaultUris.matches("https://x.com/a", VaultUris.MATCH_STARTS_WITH, "https://x.com/a/b"));
        assertTrue(VaultUris.matches("https://x.com/a", VaultUris.MATCH_EXACT, "https://x.com/a"));
        assertTrue(VaultUris.matches("^https://x\\.com", VaultUris.MATCH_REGEX, "https://x.com/q"));
        assertFalse(VaultUris.matches("([", VaultUris.MATCH_REGEX, "https://x.com"));
        assertFalse(VaultUris.matches("https://x.com", VaultUris.MATCH_NEVER, "https://x.com"));
    }

    @Test
    public void anAddressIsItsOwnSite() {
        assertEquals("10.0.1.1", VaultUris.baseDomain("10.0.1.1"));
        assertFalse(VaultUris.matches("http://10.0.1.1", null, "http://192.1.1.1"));
    }

    @Test
    public void appsMatchByPackageOnly() {
        String app = VaultUris.forApp("com.example.bank");
        assertTrue(VaultUris.matches("androidapp://com.example.bank", null, app));
        assertFalse(VaultUris.matches("androidapp://com.example.bank.evil", null, app));
        assertFalse(VaultUris.matches("https://com.example.bank", null, app));
        assertFalse(VaultUris.matches("androidapp://com.example.bank", null, "https://bank.example.com"));
    }

    @Test
    public void wildcardMeansTheDomain() {
        assertTrue(VaultUris.matches("*.example.com", null, "https://login.example.com"));
    }
}
