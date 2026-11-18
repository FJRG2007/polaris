package app.polaris.mobile;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONObject;

/**
 * "Is this a Polaris?", asked while the address is typed, the same three questions in the same order as the desktop
 * app (desktop/src/shared/server-identity.ts): /api/polaris/identity, then for an install that predates it
 * /api/instance, then /api/health. An address is kept only when one of them answers in Polaris's own shape, so a
 * typo says "that is not Polaris" here instead of opening a window onto somebody else's site.
 */
final class ServerProbe {
    enum Verdict { POLARIS, STARTING, NOT_POLARIS, REDIRECTS, UNREACHABLE }

    static final int TIMEOUT_MS = 5_000;
    static final int MAX_BODY_BYTES = 4_096;

    private ServerProbe() {
    }

    /** Blocking: call it off the main thread. */
    static Verdict probe(String origin) {
        try {
            Reply identity = ask(origin, "/api/polaris/identity");
            if (identity.redirect) return Verdict.REDIRECTS;
            if (identity.status == 200) return isIdentity(identity.body) ? Verdict.POLARIS : Verdict.NOT_POLARIS;
            if (!moveOn(identity.status)) return Verdict.NOT_POLARIS;

            Reply instance = ask(origin, "/api/instance");
            if (instance.redirect) return Verdict.REDIRECTS;
            if (instance.status == 200) return isInstance(instance.body) ? Verdict.POLARIS : Verdict.NOT_POLARIS;
            if (!moveOn(instance.status)) return Verdict.NOT_POLARIS;

            Reply health = ask(origin, "/api/health");
            if (health.redirect) return Verdict.REDIRECTS;
            return healthVerdict(health.status, health.body);
        } catch (Exception unreachable) {
            return Verdict.UNREACHABLE;
        }
    }

    /** The identity route's exact shape: the product marker and a protocol version. */
    static boolean isIdentity(String body) {
        JSONObject json = parse(body);
        if (json == null || !"polaris".equals(json.opt("product"))) return false;
        Object protocol = json.opt("protocol");
        return protocol instanceof Integer && (Integer) protocol >= 1 && (Integer) protocol <= 1_000;
    }

    static boolean isInstance(String body) {
        JSONObject json = parse(body);
        if (json == null) return false;
        String id = json.optString("id", "");
        String key = json.optString("publicKey", "");
        return id.matches("[A-Za-z0-9_-]{8,64}") && key.matches("[A-Za-z0-9_-]{43}") && json.optJSONArray("addresses") != null;
    }

    static Verdict healthVerdict(int status, String body) {
        JSONObject json = parse(body);
        String state = json == null ? "" : json.optString("status", "");
        if (status == 200 && state.equals("ok")) return Verdict.POLARIS;
        if (status == 503 && state.equals("error")) return Verdict.STARTING;
        return Verdict.NOT_POLARIS;
    }

    /** A route an older install does not have, or one that is busy: ask the next question. */
    private static boolean moveOn(int status) {
        return status == 404 || status == 429 || status == 503;
    }

    private static JSONObject parse(String body) {
        if (body == null) return null;
        try {
            return new JSONObject(body);
        } catch (Exception notJson) {
            return null;
        }
    }

    private static final class Reply {
        final int status;
        final String body;
        final boolean redirect;

        Reply(int status, String body, boolean redirect) {
            this.status = status;
            this.body = body;
            this.redirect = redirect;
        }
    }

    private static Reply ask(String origin, String path) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) return new Reply(status, null, true);
            String type = connection.getContentType();
            if (type == null || !type.toLowerCase(Locale.ROOT).contains("json")) return new Reply(status, null, false);
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            return new Reply(status, stream == null ? null : readCapped(stream), false);
        } finally {
            connection.disconnect();
        }
    }

    private static String readCapped(InputStream stream) throws Exception {
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (out.size() + read > MAX_BODY_BYTES) return null;
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
