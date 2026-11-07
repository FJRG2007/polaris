package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class RemoteCatalogTest {

    private static final String CHOICE = "0b8a3c4e-6f2d-4a1b-9c7e-5d3f2a1b0c9d";

    private static Catalog.Item item(String kind, String id, int minSdk) {
        return new Catalog.Item(id, kind, id, "", kind + "-" + id + ".jpg", id + ".bin", 10,
                "0000000000000000000000000000000000000000000000000000000000000000", minSdk,
                Collections.emptyList(), false, Catalog.ADDON.equals(kind) ? "app.polaris.addon." + id : null);
    }

    private static RemoteCatalog.Pick theme(String json) throws JSONException {
        return RemoteCatalog.desiredTheme(new JSONObject(json));
    }

    private static RemoteCatalog.Pick addons(String json) throws JSONException {
        return RemoteCatalog.desiredAddons(new JSONObject(json));
    }

    @Test
    public void readsTheThemePickedAndItsChoice() throws JSONException {
        RemoteCatalog.Pick pick = theme("{\"desired\":{\"theme\":{\"id\":\"stockholm\",\"choice\":\""
                + CHOICE.toUpperCase() + "\"}}}");
        assertEquals(Collections.singletonList("stockholm"), pick.ids);
        assertEquals(CHOICE, pick.choice);
    }

    @Test
    public void keepsItsThemeWhenNothingWasPickedOrTheBlockIsMalformed() throws JSONException {
        assertNull(theme("{}"));
        assertNull(theme("{\"desired\":null}"));
        assertNull(theme("{\"desired\":{\"blocking\":true,\"choice\":\"" + CHOICE + "\"}}"));
        assertNull(theme("{\"desired\":{\"theme\":{\"id\":\"stockholm\"}}}"));
        assertNull(theme("{\"desired\":{\"theme\":{\"id\":\"stockholm\",\"choice\":\"not-a-uuid\"}}}"));
        assertNull(theme("{\"desired\":{\"theme\":{\"id\":\"../etc\",\"choice\":\"" + CHOICE + "\"}}}"));
        assertNull(theme("{\"desired\":{\"theme\":{\"id\":7,\"choice\":\"" + CHOICE + "\"}}}"));
        assertNull(theme("{\"desired\":{\"theme\":\"stockholm\"}}"));
        assertNull(RemoteCatalog.desiredTheme(null));
    }

    @Test
    public void readsTheAddonsPickedInOrderWithoutDuplicates() throws JSONException {
        RemoteCatalog.Pick pick = addons("{\"desired\":{\"addons\":{\"ids\":[\"weather\",\"tatami\",\"weather\"],"
                + "\"choice\":\"" + CHOICE + "\"}}}");
        assertEquals(Arrays.asList("weather", "tatami"), pick.ids);
        assertEquals(CHOICE, pick.choice);
        assertTrue(addons("{\"desired\":{\"addons\":{\"ids\":[],\"choice\":\"" + CHOICE + "\"}}}").ids.isEmpty());
    }

    @Test
    public void refusesAnAddonsBlockThatDoesNotRead() throws JSONException {
        assertNull(addons("{\"desired\":{\"addons\":{\"ids\":[\"weather\"]}}}"));
        assertNull(addons("{\"desired\":{\"addons\":{\"ids\":\"weather\",\"choice\":\"" + CHOICE + "\"}}}"));
        assertNull(addons("{\"desired\":{\"addons\":{\"ids\":[\"Weather!\"],\"choice\":\"" + CHOICE + "\"}}}"));
        StringBuilder many = new StringBuilder("[");
        for (int i = 0; i <= RemoteCatalog.MAX_ADDONS; i++) many.append(i == 0 ? "" : ",").append("\"a").append(i).append('"');
        assertNull(addons("{\"desired\":{\"addons\":{\"ids\":" + many + "],\"choice\":\"" + CHOICE + "\"}}}"));
    }

    @Test
    public void actsOncePerChoice() throws JSONException {
        RemoteCatalog.Pick pick = theme("{\"desired\":{\"theme\":{\"id\":\"weeb\",\"choice\":\"" + CHOICE + "\"}}}");
        assertTrue(RemoteCatalog.due(pick, null));
        assertTrue(RemoteCatalog.due(pick, "11111111-2222-4333-8444-555555555555"));
        assertFalse(RemoteCatalog.due(pick, CHOICE));
        assertFalse(RemoteCatalog.due(null, null));
    }

    @Test
    public void findsAnItemByKindAndId() {
        List<Catalog.Item> catalog = Arrays.asList(item(Catalog.THEME, "weather", 0), item(Catalog.ADDON, "weather", 0));
        assertEquals(Catalog.ADDON, RemoteCatalog.find(catalog, Catalog.ADDON, "weather").kind);
        assertEquals(Catalog.THEME, RemoteCatalog.find(catalog, Catalog.THEME, "weather").kind);
        assertNull(RemoteCatalog.find(catalog, Catalog.THEME, "stockholm"));
        assertNull(RemoteCatalog.find(null, Catalog.THEME, "weather"));
    }

    @Test
    public void decidesWhatIsKnownBeforeDownloading() {
        assertEquals(RemoteCatalog.Outcome.UNAVAILABLE, RemoteCatalog.before(null, 30, false));
        assertEquals(RemoteCatalog.Outcome.UNAVAILABLE, RemoteCatalog.before(item(Catalog.ADDON, "x", 31), 30, false));
        assertEquals(RemoteCatalog.Outcome.DONE, RemoteCatalog.before(item(Catalog.ADDON, "x", 0), 30, true));
        assertNull(RemoteCatalog.before(item(Catalog.ADDON, "x", 30), 30, false));
        // A theme is applied again even when it is the one worn: the owner asked for it.
        assertNull(RemoteCatalog.before(item(Catalog.THEME, "x", 0), 30, true));
    }

    @Test
    public void reportsTheThemeInTheInstancesWords() {
        assertEquals("applied", RemoteCatalog.themeReport(RemoteCatalog.Outcome.DONE));
        assertEquals("unavailable", RemoteCatalog.themeReport(RemoteCatalog.Outcome.UNAVAILABLE));
        assertEquals("failed", RemoteCatalog.themeReport(RemoteCatalog.Outcome.FAILED));
        assertNull(RemoteCatalog.themeReport(null));
    }

    @Test
    public void reportsTheAddonsAsAWhole() {
        RemoteCatalog.Outcome done = RemoteCatalog.Outcome.DONE;
        RemoteCatalog.Outcome asked = RemoteCatalog.Outcome.ASKED;
        RemoteCatalog.Outcome unavailable = RemoteCatalog.Outcome.UNAVAILABLE;
        RemoteCatalog.Outcome failed = RemoteCatalog.Outcome.FAILED;
        assertEquals("installed", RemoteCatalog.addonsReport(Collections.emptyList()));
        assertEquals("installed", RemoteCatalog.addonsReport(Arrays.asList(done, done)));
        assertEquals("asked", RemoteCatalog.addonsReport(Arrays.asList(done, asked, unavailable)));
        assertEquals("unavailable", RemoteCatalog.addonsReport(Arrays.asList(done, unavailable)));
        assertEquals("failed", RemoteCatalog.addonsReport(Arrays.asList(asked, failed, unavailable)));
    }

    @Test
    public void addonsAskedAboutBecomeInstalledOnceTheyAre() {
        assertEquals("installed", RemoteCatalog.currentAddons("asked", true));
        assertEquals("asked", RemoteCatalog.currentAddons("asked", false));
        assertEquals("failed", RemoteCatalog.currentAddons("failed", true));
        assertNull(RemoteCatalog.currentAddons(null, true));
    }

    @Test
    public void addsTheReportAndTheChoiceItAnswers() {
        String path = "/api/tv/state?versionName=3.6&versionCode=15";
        assertEquals(path + "&theme=applied&themeChoice=" + CHOICE,
                RemoteCatalog.withReport(path, "theme", "applied", CHOICE));
        assertEquals("/api/tv/state?addons=asked&addonsChoice=" + CHOICE,
                RemoteCatalog.withReport("/api/tv/state", "addons", "asked", CHOICE));
        // The instance ignores a report that names no choice, so none is sent.
        assertEquals(path, RemoteCatalog.withReport(path, "theme", "applied", null));
        assertEquals(path, RemoteCatalog.withReport(path, "theme", "applied", "nope"));
        assertEquals(path, RemoteCatalog.withReport(path, "theme", null, CHOICE));
    }
}
