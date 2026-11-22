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

    private static final String A = "https://a.example.test";
    private static final String B = "https://b.example.test";

    @Test
    public void theOfficialSeasonWinsOverAnotherServersOwn() {
        String stored = SeasonIcon.withReport("", A, "halloween", false, NOW);
        stored = SeasonIcon.withReport(stored, B, "winter", true, NOW);
        assertEquals(".SeasonWinter", SeasonIcon.wantedAcross(stored, NOW));
        String reversed = SeasonIcon.withReport(SeasonIcon.withReport("", B, "winter", true, NOW), A, "halloween", false, NOW);
        assertEquals(".SeasonWinter", SeasonIcon.wantedAcross(reversed, NOW));
    }

    @Test
    public void twoServersOwnSeasonsSettleByOriginWhicheverSpokeLast() {
        String one = SeasonIcon.withReport(SeasonIcon.withReport("", B, "winter", false, NOW), A, "halloween", false, NOW);
        String two = SeasonIcon.withReport(SeasonIcon.withReport("", A, "halloween", false, NOW), B, "winter", false, NOW);
        assertEquals(".SeasonHalloween", SeasonIcon.wantedAcross(one, NOW));
        assertEquals(".SeasonHalloween", SeasonIcon.wantedAcross(two, NOW));
    }

    @Test
    public void aServerWithNoSeasonNeitherWinsNorBlocks() {
        String stored = SeasonIcon.withReport(SeasonIcon.withReport("", A, "", false, NOW), B, "winter", false, NOW);
        assertEquals(".SeasonWinter", SeasonIcon.wantedAcross(stored, NOW));
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.wantedAcross(SeasonIcon.withReport("", A, "", false, NOW), NOW));
    }

    @Test
    public void noReportAtAllLeavesTheSingleLastWord() {
        assertEquals(null, SeasonIcon.wantedAcross("", NOW));
        assertEquals(null, SeasonIcon.wantedAcross(SeasonIcon.withReport("", A, "winter", true, NOW - 15 * DAY), NOW));
    }

    @Test
    public void aServerReportingAgainReplacesItsOwnLine() {
        String stored = SeasonIcon.withReport(SeasonIcon.withReport("", A, "winter", true, NOW), A, "", false, NOW);
        assertEquals(SeasonIcon.PLAIN, SeasonIcon.wantedAcross(stored, NOW));
    }
}
