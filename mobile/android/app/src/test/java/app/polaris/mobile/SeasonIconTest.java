package app.polaris.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class SeasonIconTest {
    private static final long DAY = 24L * 60 * 60 * 1000;
    private static final long NOW = 1_800_000_000_000L;

    @Test
    public void eachSeasonHasItsOwnLauncherEntry() {
        assertEquals(".SeasonHalloween", SeasonIcon.entryFor("halloween"));
        assertEquals(".SeasonWinter", SeasonIcon.entryFor("winter"));
        assertEquals(".SeasonNewYear", SeasonIcon.entryFor("newYear"));
        assertEquals(".SeasonLunarNewYear", SeasonIcon.entryFor("lunarNewYear"));
    }

    @Test
    public void noSeasonOrOneThisAppPredatesIsThePlainIcon() {
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.entryFor(""));
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.entryFor(null));
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.entryFor("midsummer"));
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.entryFor("Winter"));
    }

    @Test
    public void theLastSeasonThePageNamedIsWorn() {
        assertEquals(".SeasonWinter", SeasonIcon.wanted("winter", NOW - DAY, NOW));
    }

    @Test
    public void aSeasonNobodyRepeatedForTwoWeeksFallsBackToPlain() {
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.wanted("winter", NOW - 15 * DAY, NOW));
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.wanted("winter", 0, NOW));
    }

    @Test
    public void aClockThatWentBackwardsFallsBackToPlain() {
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.wanted("winter", NOW + DAY, NOW));
    }
}
