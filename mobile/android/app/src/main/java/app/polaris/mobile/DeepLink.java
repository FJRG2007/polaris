package app.polaris.mobile;

import java.net.URI;
import java.net.URLDecoder;

/**
 * `polaris://open?server=<origin>&path=<path>`: a page of a Polaris, opened in this app by a link somebody followed -
 * the same link, read the same way, as the desktop app's (`desktop/src/shared/deep-link.ts`).
 *
 * Any website can start such a link, so it only ever names a page to show: it carries nothing, and a page acts only on
 * what somebody then presses. A Polaris that is not on this phone is never opened from one without a yes. Pure, so it
 * is tested off the phone.
 */
final class DeepLink {
    final String server;
    final String path;

    private DeepLink(String server, String path) {
        this.server = server;
        this.path = path;
    }

    /** What a link asks for, or null when it is not one of ours. */
    static DeepLink read(String value) {
        if (value == null || value.length() > 2048) return null;
        URI link;
        try {
            link = new URI(value);
        } catch (Exception malformed) {
            return null;
        }
        if (!"polaris".equalsIgnoreCase(link.getScheme()) || !"open".equalsIgnoreCase(link.getHost())) return null;
        String query = link.getRawQuery() == null ? "" : link.getRawQuery();
        String server = HostList.originOf(param(query, "server"));
        if (server == null) return null;
        String path = param(query, "path");
        if (path == null) path = "/";
        if (!path.startsWith("/") || path.startsWith("//") || path.contains("\\")) return null;
        return new DeepLink(server, path);
    }

    /** The page's full address. */
    String url() {
        return server + path;
    }

    private static String param(String query, String key) {
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            String name = equals < 0 ? pair : pair.substring(0, equals);
            if (!name.equals(key)) continue;
            try {
                return URLDecoder.decode(equals < 0 ? "" : pair.substring(equals + 1), "UTF-8");
            } catch (Exception malformed) {
                return null;
            }
        }
        return null;
    }
}
