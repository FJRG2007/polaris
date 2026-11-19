package app.polaris.mobile;

import android.content.Context;
import android.webkit.CookieManager;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Requests the app makes to its Polaris outside the page: signed in as the page is (its cookies, its User-Agent),
 * and, for what must come from this phone alone, signed with the phone's own key against a fresh challenge.
 */
final class PolarisHttp {
    private PolarisHttp() {
    }

    /** What came back. */
    static final class Answer {
        int status;
        String type;
        final Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];

        JSONObject json() throws JSONException {
            return new JSONObject(new String(body, StandardCharsets.UTF_8));
        }

        /** The instance's own sentence when it sent one, else the app's. */
        String error(String fallback) {
            try {
                String said = json().optString("error", "");
                if (!said.isEmpty()) return said;
            } catch (JSONException ignored) {
                // Not JSON: said in the app's own words.
            }
            return fallback;
        }
    }

    /** Refused by the instance, with what it said. */
    static final class Refused extends Exception {
        final int status;

        Refused(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    /** One request. `keep` names the response headers to hold on to. */
    static Answer request(Context context, String address, String method, String json, int maxBytes, String... keep)
            throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            connection.setRequestMethod(method);
            String cookie = CookieManager.getInstance().getCookie(address);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("User-Agent", AppAgent.of(context));
            if (json != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                }
            }
            Answer answer = new Answer();
            answer.status = connection.getResponseCode();
            answer.type = connection.getContentType();
            for (String name : keep) {
                String value = connection.getHeaderField(name);
                if (value != null) answer.headers.put(name, value);
            }
            InputStream in = answer.status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (in != null) {
                try (InputStream stream = in) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] chunk = new byte[64 * 1024];
                    int read;
                    while ((read = stream.read(chunk)) != -1) {
                        if (out.size() + read > maxBytes) throw new IOException("too large");
                        out.write(chunk, 0, read);
                    }
                    answer.body = out.toByteArray();
                }
            }
            return answer;
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Something only this phone may do: its key registered (again - it is how a key follows the account the app is
     * signed in to), a challenge taken from `address`, and the challenge signed and sent back to it.
     */
    static Answer signed(
            Context context,
            String origin,
            String address,
            String purpose,
            String target,
            String fallback,
            int maxBytes,
            String... keep)
            throws IOException, GeneralSecurityException, JSONException, Refused {
        String key = DeviceKey.publicKey();
        JSONObject register = new JSONObject().put("publicKey", key).put("platform", "android");
        Answer registered = request(context, origin + "/api/mobile/device-key", "POST", register.toString(), 64 * 1024);
        if (registered.status >= 400) throw new Refused(registered.status, registered.error(fallback));
        Answer challenge = request(context, address, "GET", null, 64 * 1024);
        if (challenge.status >= 400) throw new Refused(challenge.status, challenge.error(fallback));
        String nonce = challenge.json().getString("challenge");
        JSONObject proof = new JSONObject()
                .put("challenge", nonce)
                .put("publicKey", key)
                .put("signature", DeviceKey.sign(purpose + ":" + target + ":" + nonce));
        Answer answer = request(context, address, "POST", proof.toString(), maxBytes, keep);
        if (answer.status >= 400) throw new Refused(answer.status, answer.error(fallback));
        return answer;
    }
}
