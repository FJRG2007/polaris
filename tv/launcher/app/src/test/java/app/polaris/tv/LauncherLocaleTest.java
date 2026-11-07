package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class LauncherLocaleTest {
    @Test
    public void plainTagsBecomeLocales() {
        assertEquals("vi", LauncherLocale.parse("vi").getLanguage());
        assertEquals("BR", LauncherLocale.parse("pt-BR").getCountry());
        assertEquals("fil", LauncherLocale.parse(" fil ").getLanguage());
    }

    @Test
    public void tagsWithScriptsAndExtensionsBecomeLocales() {
        assertEquals("Latn", LauncherLocale.parse("sr-Latn").getScript());
        assertEquals("ar", LauncherLocale.parse("ar-EG-u-nu-latn").getLanguage());
        assertEquals("latn", LauncherLocale.parse("ar-EG-u-nu-latn").getUnicodeLocaleType("nu"));
    }

    @Test
    public void emptyOrMalformedTagsFollowTheTv() {
        assertNull(LauncherLocale.parse(""));
        assertNull(LauncherLocale.parse(null));
        assertNull(LauncherLocale.parse("Vietnamese"));
        assertNull(LauncherLocale.parse("vi_VN"));
        assertNull(LauncherLocale.parse("../vi"));
        assertNull(LauncherLocale.parse("vi-"));
        assertNull(LauncherLocale.parse("vi--VN"));
    }

    @Test
    public void aLanguagePickedOnTheTvWins() {
        assertEquals("fr", LauncherLocale.resolve("fr", "es-ES", "vi"));
        assertEquals("fr", LauncherLocale.resolve(" fr ", null, ""));
    }

    @Test
    public void aLinkedTvFollowsItsAccountUnlessSomethingWasPicked() {
        assertEquals("es-ES", LauncherLocale.resolve(null, "es-ES", "vi"));
        // "Same as the TV" means the account's while linked.
        assertEquals("es-ES", LauncherLocale.resolve("", "es-ES", "vi"));
        // A malformed choice is no choice.
        assertEquals("es-ES", LauncherLocale.resolve("vi_VN", "es-ES", ""));
    }

    @Test
    public void anUnlinkedTvKeepsTheThemeOrTheTvsLanguage() {
        assertEquals("vi", LauncherLocale.resolve(null, "", "vi"));
        assertEquals("vi", LauncherLocale.resolve(null, null, "vi"));
        assertEquals("", LauncherLocale.resolve("", "", "vi"));
        assertEquals("", LauncherLocale.resolve(null, "not a tag", null));
    }
}
