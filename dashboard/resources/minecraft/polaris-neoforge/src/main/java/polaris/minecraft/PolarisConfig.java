package polaris.minecraft;

import java.net.URI;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * What the server's environment says about Polaris login.
 *
 * Polaris writes all four variables together when it switches the mod on, so one
 * of them missing while the switch is on is not a setting somebody chose - it is a
 * server that cannot check anybody, and it is reported as that (BROKEN) rather than
 * quietly treated as off.
 */
record PolarisConfig(State state, String baseUrl, String serverId, String token, String problem) {
    enum State { OFF, ON, BROKEN }

    private static final Pattern SERVER_ID =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    static PolarisConfig fromEnvironment(Map<String, String> env) {
        String flag = env.getOrDefault("POLARIS_LOGIN", "").trim().toLowerCase(Locale.ROOT);
        if (!flag.equals("on")) return new PolarisConfig(State.OFF, "", "", "", "");
        String url = env.getOrDefault("POLARIS_URL", "").trim().replaceAll("/+$", "");
        String id = env.getOrDefault("POLARIS_SERVER_ID", "").trim();
        String token = env.getOrDefault("POLARIS_SERVER_TOKEN", "").trim();
        String problem = null;
        if (url.isEmpty()) problem = "POLARIS_URL is not set";
        else if (!isHttpUrl(url)) problem = "POLARIS_URL is not an http or https address";
        else if (!SERVER_ID.matcher(id).matches()) problem = "POLARIS_SERVER_ID is not set to this server's id";
        else if (token.isEmpty()) problem = "POLARIS_SERVER_TOKEN is not set";
        if (problem != null) return new PolarisConfig(State.BROKEN, url, id, "", problem);
        return new PolarisConfig(State.ON, url, id, token, "");
    }

    private static boolean isHttpUrl(String value) {
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            return uri.getHost() != null && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
        } catch (IllegalArgumentException invalid) {
            return false;
        }
    }

    /** Never print the token. */
    @Override
    public String toString() {
        return "PolarisConfig[state=" + state + ", baseUrl=" + baseUrl + ", serverId=" + serverId + "]";
    }
}
