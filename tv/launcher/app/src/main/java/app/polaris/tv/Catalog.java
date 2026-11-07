package app.polaris.tv;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The Themes & add-ons catalog (catalog.json) published with this launcher's own tv-v release by
 * tv/tools/catalog.py. Pure, so parsing is a unit test.
 *
 * The instance's /api/tv/update proxies only the launcher APK, so the catalog and its files come from the GitHub
 * release itself, over HTTPS, and every file is checked against the size and SHA-256 the catalog lists before it is
 * unpacked or installed. An entry that does not read cleanly is left out rather than shown half-filled.
 */
final class Catalog {

    static final String THEME = "theme";
    static final String ADDON = "addon";
    static final int VERSION = 1;
    /** The repository the release workflow publishes to (POLARIS_REPO's default on the instance). */
    static final String RELEASES = "https://github.com/FJRG2007/polaris/releases/download/";
    static final String FILE_NAME = "catalog.json";
    static final long MAX_CATALOG_BYTES = 512 * 1024;
    static final long MAX_APK_BYTES = 64L * 1024 * 1024;
    static final long MAX_ZIP_BYTES = ThemeUnpack.MAX_BYTES;
    static final long MAX_SCREENSHOT_BYTES = 300 * 1024;

    private static final Pattern ID = Pattern.compile("[a-z0-9][a-z0-9_-]{0,63}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern PACKAGE = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+");
    private static final Pattern PERMISSION = Pattern.compile("[A-Za-z0-9_.]{1,200}");

    static final class Item {
        final String id;
        final String kind;
        final String name;
        final String description;
        final String screenshot;
        final String file;
        final long size;
        final String sha256;
        final int minSdk;
        final List<String> permissions;
        final boolean network;
        /** The add-on's application id; null for a theme. */
        final String packageName;

        Item(String id, String kind, String name, String description, String screenshot, String file, long size,
             String sha256, int minSdk, List<String> permissions, boolean network, String packageName) {
            this.id = id;
            this.kind = kind;
            this.name = name;
            this.description = description;
            this.screenshot = screenshot;
            this.file = file;
            this.size = size;
            this.sha256 = sha256;
            this.minSdk = minSdk;
            this.permissions = permissions;
            this.network = network;
            this.packageName = packageName;
        }

        boolean isTheme() {
            return THEME.equals(kind);
        }

        /** True when this TV's Android is new enough (an unknown minSdk counts as compatible). */
        boolean runsOn(int sdk) {
            return minSdk <= 0 || sdk >= minSdk;
        }
    }

    private Catalog() {}

    /** The release this launcher came from: the catalog always matches the build reading it. */
    static String tag(String versionName) {
        return "tv-v" + versionName;
    }

    /** The address of a file in the release, or null for a name that is not a plain file name. */
    static String url(String versionName, String name) {
        if (!SelfUpdate.validVersion(versionName) || name == null || !name.matches("[A-Za-z0-9_.-]{1,120}")
                || name.startsWith(".")) {
            return null;
        }
        return RELEASES + tag(versionName) + "/" + name;
    }

    /** Only GitHub's own hosts over HTTPS, the same rule the instance's release fetch follows. */
    static boolean allowedHost(String address) {
        try {
            URI uri = new URI(address);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            return "https".equals(uri.getScheme())
                    && ("github.com".equals(host) || host.endsWith(".githubusercontent.com"));
        } catch (java.net.URISyntaxException bad) {
            return false;
        }
    }

    /** Every entry that reads cleanly, in the catalog's order; empty for a catalog this build cannot read. */
    static List<Item> parse(String body) {
        if (body == null) return Collections.emptyList();
        try {
            JSONObject root = new JSONObject(body);
            if (root.optInt("version", -1) != VERSION) return Collections.emptyList();
            JSONArray items = root.optJSONArray("items");
            if (items == null) return Collections.emptyList();
            List<Item> out = new ArrayList<>();
            List<String> seen = new ArrayList<>();
            for (int i = 0; i < items.length(); i++) {
                Item item = item(items.optJSONObject(i));
                if (item == null || seen.contains(item.kind + "/" + item.id)) continue;
                seen.add(item.kind + "/" + item.id);
                out.add(item);
            }
            return out;
        } catch (JSONException unreadable) {
            return Collections.emptyList();
        }
    }

    private static Item item(JSONObject o) {
        if (o == null) return null;
        String id = o.optString("id", "");
        String kind = o.optString("kind", "");
        if (!ID.matcher(id).matches() || !(THEME.equals(kind) || ADDON.equals(kind))) return null;
        boolean theme = THEME.equals(kind);
        String file = o.optString("file", "");
        String screenshot = o.optString("screenshot", "");
        String expectedFile = kind + "-" + id + (theme ? ".zip" : ".apk");
        if (!expectedFile.equals(file) || !(kind + "-" + id + ".jpg").equals(screenshot)) return null;
        long size = o.optLong("size", -1);
        if (size <= 0 || size > (theme ? MAX_ZIP_BYTES : MAX_APK_BYTES)) return null;
        String sha = o.optString("sha256", "");
        if (!SHA256.matcher(sha).matches()) return null;
        String name = clean(o.optString("name", ""), 80);
        if (name.isEmpty()) return null;
        String packageName = null;
        if (!theme) {
            packageName = o.optString("package", "");
            if (!PACKAGE.matcher(packageName).matches() || SelfUpdate.PACKAGE.equals(packageName)) return null;
        }
        List<String> permissions = new ArrayList<>();
        JSONArray granted = o.optJSONArray("permissions");
        if (granted != null) {
            for (int i = 0; i < granted.length(); i++) {
                String p = granted.optString(i, "");
                if (PERMISSION.matcher(p).matches()) permissions.add(p);
            }
        }
        return new Item(id, kind, name, clean(o.optString("description", ""), 600), screenshot, file, size, sha,
                o.optInt("minSdk", 0), Collections.unmodifiableList(permissions), o.optBoolean("network", false),
                packageName);
    }

    /** Only the entries of one kind, or all of them for a null kind. */
    static List<Item> ofKind(List<Item> items, String kind) {
        if (kind == null) return items;
        List<Item> out = new ArrayList<>();
        for (Item item : items) if (kind.equals(item.kind)) out.add(item);
        return out;
    }

    /** Without control characters, trimmed and cut to {@code max} characters. */
    static String clean(String text, int max) {
        String s = text == null ? "" : text.replaceAll("\\p{Cntrl}", " ").trim();
        return s.length() > max ? s.substring(0, max).trim() : s;
    }
}
