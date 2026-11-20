package app.polaris.mobile;

import java.net.URI;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * A list of Polaris hosts carried from another device: the code the desktop app copies, the `polaris://hosts` link its
 * QR holds (which the phone's camera opens this app on), or the file it exports. The same three shapes, read the same
 * way, as `host-list` in the dashboard's core package, so whatever the desktop app or the browser extension exports is
 * read here.
 *
 * Only addresses and names cross, never a session: every host taken in still asks to sign in. Whatever is read is
 * untrusted - every address must be a bare http(s) origin, names are trimmed and capped, and so is the list. Pure, so
 * it is tested off the phone.
 */
final class HostList {
    static final String PREFIX = "polaris-hosts:1:";
    static final String LINK = "polaris://hosts";
    /** The most hosts one list carries, the same cap the desktop app writes with. */
    static final int MAX = 50;
    static final int NAME_MAX = 40;
    private static final int INPUT_MAX = 64 * 1024;
    private static final String FILE_KIND = "polaris-hosts";

    /** One host as it travels. `name` is null when nobody named it. */
    static final class Entry {
        final String origin;
        final String name;

        Entry(String origin, String name) {
            this.origin = origin;
            this.name = name;
        }
    }

    private HostList() {
    }

    /** The hosts in a code, a link or a file, or null when the text is none of them. An empty list is a list. */
    static List<Entry> read(String raw) {
        if (raw == null || raw.length() > INPUT_MAX) return null;
        String text = raw.trim();
        if (text.startsWith(PREFIX)) return fromCode(text);
        if (text.toLowerCase(Locale.ROOT).startsWith(LINK + "?")) {
            String list = query(text.substring(text.indexOf('?') + 1), "list");
            return list != null && list.startsWith(PREFIX) ? fromCode(list) : null;
        }
        if (text.startsWith("{")) return fromFile(text);
        return null;
    }

    /**
     * The list as the code the desktop app copies, read back by {@link #read}: rows of `[address]` or `[address, name]`,
     * https left out of each address to keep it short, base64url without padding. Capped at {@link #MAX}.
     */
    static String encode(List<Entry> hosts) {
        JSONArray rows = new JSONArray();
        for (Entry entry : hosts) {
            if (rows.length() >= MAX) break;
            String origin = originOf(entry.origin);
            if (origin == null) continue;
            JSONArray row = new JSONArray();
            row.put(origin.startsWith("https://") ? origin.substring("https://".length()) : origin);
            String name = nameOf(entry.name);
            if (name != null) row.put(name);
            rows.put(row);
        }
        byte[] json = rows.toString().getBytes(StandardCharsets.UTF_8);
        return PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(json);
    }

    /** The same list as the link the desktop app's QR holds, which opens this app wherever it is scanned. */
    static String link(List<Entry> hosts) {
        return LINK + "?list=" + encode(hosts);
    }

    /** One parameter of a query string, decoded, or null. */
    private static String query(String query, String key) {
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            String name = equals < 0 ? pair : pair.substring(0, equals);
            if (!name.equals(key)) continue;
            String value = equals < 0 ? "" : pair.substring(equals + 1);
            try {
                return java.net.URLDecoder.decode(value, "UTF-8");
            } catch (Exception malformed) {
                return null;
            }
        }
        return null;
    }

    private static List<Entry> fromCode(String code) {
        String json = fromBase64Url(code.substring(PREFIX.length()));
        if (json == null) return null;
        Object rows;
        try {
            rows = new JSONTokener(json).nextValue();
        } catch (JSONException unreadable) {
            return null;
        }
        if (!(rows instanceof JSONArray)) return null;
        JSONArray list = (JSONArray) rows;
        List<String[]> read = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONArray row = list.optJSONArray(i);
            if (row == null) continue;
            read.add(new String[] {stringAt(row.opt(0)), stringAt(row.opt(1))});
        }
        return settle(read);
    }

    private static List<Entry> fromFile(String text) {
        Object file;
        try {
            file = new JSONTokener(text).nextValue();
        } catch (JSONException unreadable) {
            return null;
        }
        if (!(file instanceof JSONObject)) return null;
        JSONObject object = (JSONObject) file;
        if (!FILE_KIND.equals(object.opt("kind"))) return null;
        JSONArray hosts = object.optJSONArray("hosts");
        if (hosts == null) return null;
        List<String[]> read = new ArrayList<>();
        for (int i = 0; i < hosts.length(); i++) {
            JSONObject row = hosts.optJSONObject(i);
            if (row == null) continue;
            read.add(new String[] {stringAt(row.opt("origin")), stringAt(row.opt("name"))});
        }
        return settle(read);
    }

    private static String stringAt(Object value) {
        return value instanceof String ? (String) value : null;
    }

    /** The rows as read, with duplicates and unusable rows dropped, capped. */
    private static List<Entry> settle(List<String[]> rows) {
        List<Entry> hosts = new ArrayList<>();
        for (String[] row : rows) {
            if (hosts.size() == MAX) break;
            String origin = originOf(row[0]);
            if (origin == null) continue;
            boolean listed = false;
            for (Entry one : hosts) listed |= one.origin.equals(origin);
            if (listed) continue;
            hosts.add(new Entry(origin, nameOf(row[1])));
        }
        return Collections.unmodifiableList(hosts);
    }

    /** A bare http(s) origin, or null. A bare host in the compact form is https, the only scheme left out of it. */
    static String originOf(String value) {
        if (value == null || value.length() > 2048) return null;
        String typed = value.matches("(?i)^[a-z][a-z0-9+.-]*://.*") ? value : "https://" + value;
        URI uri;
        try {
            uri = new URI(typed);
        } catch (Exception malformed) {
            return null;
        }
        String path = uri.getRawPath();
        if (path != null && !path.isEmpty() && !path.equals("/")) return null;
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) return null;
        return ServerAddress.origin(typed);
    }

    private static String nameOf(String value) {
        if (value == null) return null;
        String name = value.replaceAll("\\s+", " ").trim();
        if (name.length() > NAME_MAX) name = name.substring(0, NAME_MAX).trim();
        return name.isEmpty() ? null : name;
    }

    private static String fromBase64Url(String code) {
        if (!code.matches("[A-Za-z0-9_-]*")) return null;
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(code);
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (IllegalArgumentException | CharacterCodingException unreadable) {
            return null;
        }
    }
}
