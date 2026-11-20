package app.polaris.mobile;

import android.content.Context;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The Polaris Vault, in the protocol it already answers at `<origin>/vault` - the same calls the browser extension
 * makes (`dashboard/apps/extension/src/lib/protocol.ts`), so this adds no server code. Signing in is being let in by a
 * browser already inside the vault (`identity/connect/authorize`): no master password is ever typed on the phone, and
 * the key travels sealed to a pair this phone made for the exchange.
 *
 * No cookie is ever sent: the vault surface is bearer-only, and the dashboard's session is a different credential.
 */
final class VaultClient {
    /** Bitwarden's device numbers, which the vault's device list reads. */
    static final int DEVICE_ANDROID = 0;

    private static final int MAX_BYTES = 32 * 1024 * 1024;

    private VaultClient() {
    }

    static final class Token {
        final String accessToken;
        final String refreshToken;
        final long expiresAt;
        final String privateKey;

        Token(String accessToken, String refreshToken, long expiresAt, String privateKey) {
            this.accessToken = accessToken;
            this.refreshToken = refreshToken;
            this.expiresAt = expiresAt;
            this.privateKey = privateKey;
        }
    }

    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }

        JSONObject json() {
            try {
                return new JSONObject(body);
            } catch (JSONException e) {
                return null;
            }
        }

        boolean ok() {
            return status >= 200 && status < 300;
        }
    }

    /** The session has ended server-side: 401/403 or a refused refresh. Only this may disconnect the phone. */
    static final class Ended extends Exception {
    }

    static String base(String origin) {
        return origin + "/vault";
    }

    static String deviceName() {
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        return model.isEmpty() ? "Android" : model;
    }

    /** Name/value pairs in order; Map.of is newer than this app's oldest Android. */
    static Map<String, String> fields(String... pairs) {
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) out.put(pairs[i], pairs[i + 1]);
        return out;
    }

    static Reply form(Context context, String url, Map<String, String> fields) throws IOException {
        StringBuilder body = new StringBuilder();
        for (Map.Entry<String, String> field : fields.entrySet()) {
            if (field.getValue() == null || field.getValue().isEmpty()) continue;
            if (body.length() > 0) body.append('&');
            body.append(URLEncoder.encode(field.getKey(), "UTF-8")).append('=')
                    .append(URLEncoder.encode(field.getValue(), "UTF-8"));
        }
        return send(context, url, "POST", null, "application/x-www-form-urlencoded", body.toString());
    }

    static Reply send(Context context, String url, String method, String bearer, String type, String body)
            throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setRequestMethod(method);
            connection.setRequestProperty("User-Agent", AppAgent.of(context));
            connection.setRequestProperty("Accept", "application/json");
            if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", type);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = "";
            if (in != null) {
                try (InputStream stream = in) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] chunk = new byte[64 * 1024];
                    int read;
                    while ((read = stream.read(chunk)) != -1) {
                        if (out.size() + read > MAX_BYTES) throw new IOException("too large");
                        out.write(chunk, 0, read);
                    }
                    text = out.toString("UTF-8");
                }
            }
            return new Reply(status, text);
        } finally {
            connection.disconnect();
        }
    }

    static Token readToken(JSONObject body) {
        if (body == null) return null;
        String access = body.optString("access_token", "");
        String refresh = body.optString("refresh_token", "");
        if (access.isEmpty() || refresh.isEmpty()) return null;
        long seconds = body.optLong("expires_in", 3600);
        // A minute short on purpose, as the extension does: a token that expires in flight reads as a refusal.
        long until = System.currentTimeMillis() + Math.max(0, seconds - 60) * 1000;
        String privateKey = body.optString("PrivateKey", "");
        return new Token(access, refresh, until, privateKey.isEmpty() ? null : privateKey);
    }

    /** A usable access token, refreshed (and the rotated refresh token stored) when the held one has run out. */
    static String accessToken(Context context) throws IOException, Ended {
        android.content.SharedPreferences prefs = VaultStore.prefs(context);
        String access = prefs.getString("access", null);
        if (access != null && prefs.getLong("accessUntil", 0) > System.currentTimeMillis()) return access;
        String refresh = prefs.getString("refresh", null);
        String origin = VaultStore.origin(context);
        if (refresh == null || origin == null) throw new Ended();
        Reply reply = form(context, base(origin) + "/identity/connect/token", fields(
                "grant_type", "refresh_token",
                "refresh_token", refresh,
                "client_id", "mobile",
                "deviceName", deviceName()));
        if (reply.status == 401 || reply.status == 403) throw new Ended();
        if (reply.status == 400) {
            JSONObject body = reply.json();
            if (body != null && "invalid_grant".equals(body.optString("error"))) throw new Ended();
        }
        Token token = reply.ok() ? readToken(reply.json()) : null;
        if (token == null) throw new IOException("refresh " + reply.status);
        VaultStore.saveToken(context, token);
        return token.accessToken;
    }

    /** Fetch everything the account can see and keep it, still encrypted. */
    static void sync(Context context) throws IOException, Ended {
        String origin = VaultStore.origin(context);
        if (origin == null) throw new Ended();
        Reply reply = send(context, base(origin) + "/api/sync?excludeDomains=true", "GET", accessToken(context), null,
                null);
        if (reply.status == 401 || reply.status == 403) throw new Ended();
        JSONObject body = reply.ok() ? reply.json() : null;
        if (body == null) throw new IOException("sync " + reply.status);
        VaultStore.saveSync(context, VaultItems.trim(body));
    }

    /** POST a new item, or PUT one rewritten whole. Answers the status, so a 409 can say somebody saved first. */
    static int write(Context context, String id, JSONObject item) throws IOException, Ended {
        String origin = VaultStore.origin(context);
        if (origin == null) throw new Ended();
        String url = base(origin) + "/api/ciphers" + (id == null ? "" : "/" + URLEncoder.encode(id, "UTF-8"));
        Reply reply = send(context, url, id == null ? "POST" : "PUT", accessToken(context), "application/json",
                item.toString());
        if (reply.status == 401) throw new Ended();
        return reply.status;
    }
}
