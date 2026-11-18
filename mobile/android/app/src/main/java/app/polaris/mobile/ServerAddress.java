package app.polaris.mobile;

import java.net.URI;
import java.util.Locale;

/**
 * What somebody types as their Polaris's address, made into the one origin the app keeps: "polaris.example.com",
 * "https://polaris.example.com/home" and "HTTPS://Polaris.Example.com/" are all "https://polaris.example.com".
 * Pure, so it is tested off the phone.
 */
final class ServerAddress {
    /** Longest address accepted; a real one is a host name and a port. */
    static final int MAX_LENGTH = 300;

    private ServerAddress() {
    }

    /** The origin, or null when the text cannot be one (empty, another scheme, no host, credentials in it). */
    static String origin(String typed) {
        if (typed == null) return null;
        String text = typed.trim();
        if (text.isEmpty() || text.length() > MAX_LENGTH) return null;
        if (!text.contains("://")) text = "https://" + text;
        URI uri;
        try {
            uri = new URI(text);
        } catch (Exception malformed) {
            return null;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty() || uri.getRawUserInfo() != null) return null;
        int port = uri.getPort();
        boolean usual = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + (usual ? "" : ":" + port);
    }

    /** Whether a link the page opens belongs to this Polaris, so it stays in the app instead of the browser. */
    static boolean sameOrigin(String origin, String url) {
        if (origin == null || url == null) return false;
        String other = origin(url.contains("://") ? url : "invalid://");
        return origin.equals(other);
    }
}
