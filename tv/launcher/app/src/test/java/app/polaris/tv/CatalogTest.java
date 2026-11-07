package app.polaris.tv;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CatalogTest {
    private static final String SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static JSONObject theme(String id) throws Exception {
        return new JSONObject().put("id", id).put("kind", "theme").put("name", "Aurora")
                .put("description", "A dark aurora").put("screenshot", "theme-" + id + ".jpg")
                .put("file", "theme-" + id + ".zip").put("size", 1234).put("sha256", SHA).put("minSdk", 26)
                .put("permissions", new JSONArray()).put("network", false).put("package", JSONObject.NULL);
    }

    private static JSONObject addon(String id) throws Exception {
        return new JSONObject().put("id", id).put("kind", "addon").put("name", "Weather")
                .put("description", "The weather").put("screenshot", "addon-" + id + ".jpg")
                .put("file", "addon-" + id + ".apk").put("size", 5000).put("sha256", SHA).put("minSdk", 28)
                .put("permissions", new JSONArray().put("android.permission.INTERNET")).put("network", true)
                .put("package", "io.example.weather");
    }

    private static String catalog(JSONObject... items) throws Exception {
        JSONArray list = new JSONArray();
        for (JSONObject item : items) list.put(item);
        return new JSONObject().put("version", 1).put("items", list).toString();
    }

    @Test public void readsThemesAndAddons() throws Exception {
        List<Catalog.Item> items = Catalog.parse(catalog(theme("aurora"), addon("weather")));
        assertEquals(2, items.size());
        Catalog.Item theme = items.get(0);
        assertTrue(theme.isTheme());
        assertEquals("theme-aurora.zip", theme.file);
        assertNull(theme.packageName);
        Catalog.Item addon = items.get(1);
        assertFalse(addon.isTheme());
        assertEquals("io.example.weather", addon.packageName);
        assertTrue(addon.network);
        assertEquals(1, addon.permissions.size());
        assertTrue(addon.runsOn(28));
        assertFalse(addon.runsOn(27));
    }

    @Test public void unreadableCatalogsAreEmpty() throws Exception {
        assertTrue(Catalog.parse(null).isEmpty());
        assertTrue(Catalog.parse("not json").isEmpty());
        assertTrue(Catalog.parse("{\"version\":2,\"items\":[]}").isEmpty());
        assertTrue(Catalog.parse("{\"version\":1}").isEmpty());
    }

    @Test public void badEntriesAreLeftOut() throws Exception {
        List<Catalog.Item> items = Catalog.parse(catalog(
                theme("../evil"),
                theme("ok").put("file", "../theme-ok.zip"),
                theme("ok2").put("screenshot", "x.jpg"),
                theme("ok3").put("sha256", "nope"),
                theme("ok4").put("size", 0),
                theme("ok5").put("size", Catalog.MAX_ZIP_BYTES + 1),
                theme("ok6").put("kind", "plugin"),
                theme("ok7").put("name", "  "),
                addon("a1").put("package", "not a package"),
                addon("a2").put("package", SelfUpdate.PACKAGE),
                addon("a3").put("size", Catalog.MAX_APK_BYTES + 1),
                theme("good")));
        assertEquals(1, items.size());
        assertEquals("good", items.get(0).id);
    }

    @Test public void duplicatesKeepTheFirst() throws Exception {
        List<Catalog.Item> items = Catalog.parse(catalog(theme("a"), theme("a").put("name", "Second")));
        assertEquals(1, items.size());
        assertEquals("Aurora", items.get(0).name);
    }

    @Test public void oddPermissionsAndControlCharactersAreDropped() throws Exception {
        List<Catalog.Item> items = Catalog.parse(catalog(addon("w")
                .put("permissions", new JSONArray().put("android.permission.INTERNET").put("bad perm\n"))
                .put("name", "Wea\nther")));
        assertEquals(1, items.get(0).permissions.size());
        assertEquals("Wea ther", items.get(0).name);
    }

    @Test public void filtersByKind() throws Exception {
        List<Catalog.Item> items = Catalog.parse(catalog(theme("a"), addon("b"), theme("c")));
        assertEquals(3, Catalog.ofKind(items, null).size());
        assertEquals(2, Catalog.ofKind(items, Catalog.THEME).size());
        assertEquals(1, Catalog.ofKind(items, Catalog.ADDON).size());
    }

    @Test public void urlsPointAtThisBuildsRelease() {
        assertEquals(Catalog.RELEASES + "tv-v3.4/catalog.json", Catalog.url("3.4", "catalog.json"));
        assertNull(Catalog.url("3.4", "../catalog.json"));
        assertNull(Catalog.url("3.4", ".hidden"));
        assertNull(Catalog.url("bad version!", "catalog.json"));
    }

    @Test public void onlyGithubOverHttps() {
        assertTrue(Catalog.allowedHost("https://github.com/x"));
        assertTrue(Catalog.allowedHost("https://objects.githubusercontent.com/x"));
        assertFalse(Catalog.allowedHost("http://github.com/x"));
        assertFalse(Catalog.allowedHost("https://github.com.evil.example/x"));
        assertFalse(Catalog.allowedHost("https://evilgithubusercontent.com/x"));
        assertFalse(Catalog.allowedHost("not a url"));
    }
}
