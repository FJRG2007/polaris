package app.polaris.tv;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import javax.net.ssl.SSLException;

/**
 * Reaching the same Polaris on another address when its usual one stops answering: this launcher's copy of
 * dashboard/packages/core/src/instance-fallback.ts, which the other clients bundle and Java cannot.
 *
 * An alternate address sees the token only after it signed a fresh nonce with the key learned over the usual
 * address. Two addresses are never assumed to be one Polaris.
 */
final class PolarisFailover {

    static final String INSTANCE_PATH = "/api/instance";
    static final String CHALLENGE_PATH = "/api/instance/challenge";
    private static final String SIGNATURE_CONTEXT = "polaris-instance-v1";
    static final long HOLD_MS = 60_000;
    static final long VERIFIED_MS = 10 * 60_000;
    static final int TIMEOUT_MS = 8_000;
    private static final int MAX_ADDRESSES = 16;

    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_-]{8,64}$");
    private static final Pattern KEY = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final Pattern SIGNATURE = Pattern.compile("^[A-Za-z0-9_-]{86}$");

    /** One answer from an address. */
    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 300;
        }
    }

    /** Sends one request. A token of null sends no credential. Throws when nothing answered. */
    interface Transport {
        Reply send(String method, String url, String body, String token) throws IOException;
    }

    /** What is kept about the instance, learned over its usual address. */
    static final class Instance {
        final String id;
        final String publicKey;
        final List<String> addresses;

        Instance(String id, String publicKey, List<String> addresses) {
            this.id = id;
            this.publicKey = publicKey;
            this.addresses = addresses;
        }
    }

    /** An http(s) origin with no path, or null. */
    static String readOrigin(String value) {
        if (value == null || value.length() > 300) return null;
        try {
            URI url = new URI(value.trim());
            String scheme = url.getScheme();
            String host = url.getHost();
            if (scheme == null || host == null || url.getRawUserInfo() != null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!scheme.equals("https") && !scheme.equals("http")) return null;
            int port = url.getPort();
            boolean usual = port == -1 || (scheme.equals("https") ? port == 443 : port == 80);
            return scheme + "://" + host.toLowerCase(Locale.ROOT) + (usual ? "" : ":" + port);
        } catch (URISyntaxException notAnAddress) {
            return null;
        }
    }

    private static final Pattern PRIVATE_IPV4 =
            Pattern.compile("^(10\\.\\d{1,3}|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.\\d{1,3}\\.\\d{1,3}$");

    /** What the address typed on the remote means: https unless it says otherwise or is plainly local. */
    static String readTyped(String typed) {
        if (typed == null) return null;
        String value = typed.trim();
        if (value.isEmpty()) return null;
        if (value.contains("://")) return readOrigin(value);
        String bare = readOrigin("http://" + value);
        if (bare == null) return null;
        return isLocal(bare) ? bare : "https://" + bare.substring("http://".length());
    }

    /** Whether this address is on the local network, where plain http is the default install. */
    static boolean isLocal(String origin) {
        try {
            String host = new URI(origin).getHost();
            if (host == null) return false;
            return host.equals("localhost") || host.equals("polaris") || host.endsWith(".local")
                    || PRIVATE_IPV4.matcher(host).matches();
        } catch (URISyntaxException notAnAddress) {
            return false;
        }
    }

    /** Whether what goes to this address, the sign-in included, travels unencrypted. */
    static boolean plain(String origin) {
        return origin.startsWith("http://");
    }

    /** Reads what GET /api/instance answered, or null. Strict: nothing malformed is half-kept. */
    static Instance readInstance(String body) {
        try {
            JSONObject record = new JSONObject(body);
            String id = record.optString("id");
            String key = record.optString("publicKey");
            JSONArray listed = record.getJSONArray("addresses");
            if (!ID.matcher(id).matches() || !KEY.matcher(key).matches() || listed.length() > MAX_ADDRESSES) return null;
            Set<String> origins = new LinkedHashSet<>();
            for (int i = 0; i < listed.length(); i++) {
                String origin = readOrigin(listed.optString(i, null));
                if (origin == null) return null;
                origins.add(origin);
            }
            return new Instance(id, key, new ArrayList<>(origins));
        } catch (JSONException | RuntimeException notOne) {
            return null;
        }
    }

    /** The bytes the instance signs. */
    static String challengeMessage(String id, String origin, String nonce) {
        return SIGNATURE_CONTEXT + "\n" + id + "\n" + origin + "\n" + nonce;
    }

    static String freshNonce(SecureRandom random) {
        byte[] nonce = new byte[32];
        random.nextBytes(nonce);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(nonce);
    }

    /** Whether a status means a gateway in front of a Polaris it cannot reach, not an answer from it. */
    static boolean isGatewayFailure(int status) {
        return status == 502 || status == 503 || status == 504 || (status >= 520 && status <= 530);
    }

    private final Transport transport;
    private final String primary;
    private final Instance instance;
    private final List<String> alternates = new ArrayList<>();
    private final Map<String, Long> verifiedUntil = new HashMap<>();
    private final Set<String> refused = new LinkedHashSet<>();
    private final Set<String> untrusted = new LinkedHashSet<>();
    private final SecureRandom random = new SecureRandom();
    private String current;
    private long heldUntil;

    PolarisFailover(Transport transport, String primary, Instance instance) {
        this.transport = transport;
        this.primary = primary;
        this.instance = instance;
        this.current = primary;
        if (instance != null) {
            for (String origin : instance.addresses) if (!origin.equals(primary)) alternates.add(origin);
        }
    }

    /** Overridden by the tests. */
    long now() {
        return System.currentTimeMillis();
    }

    private static final int SAME = 0, DIFFERENT = 1, UNREACHABLE = 2, CERTIFICATE = 3;

    private int challenge(String origin) {
        String nonce = freshNonce(random);
        Reply reply;
        try {
            String body = new JSONObject().put("nonce", nonce).toString();
            reply = transport.send("POST", origin + CHALLENGE_PATH, body, null);
        } catch (SSLException untrustedCertificate) {
            return CERTIFICATE;
        } catch (IOException | JSONException notThere) {
            return UNREACHABLE;
        }
        if (isGatewayFailure(reply.status)) return UNREACHABLE;
        try {
            JSONObject answer = new JSONObject(reply.body);
            String signature = answer.optString("signature");
            if (!reply.ok() || !instance.id.equals(answer.optString("id"))
                    || !nonce.equals(answer.optString("nonce")) || !SIGNATURE.matcher(signature).matches()) {
                return DIFFERENT;
            }
            Base64.Decoder decoder = Base64.getUrlDecoder();
            boolean signed = PolarisEd25519.verify(decoder.decode(instance.publicKey),
                    challengeMessage(instance.id, origin, nonce).getBytes(StandardCharsets.UTF_8),
                    decoder.decode(signature));
            return signed ? SAME : DIFFERENT;
        } catch (JSONException | IllegalArgumentException notPolaris) {
            return DIFFERENT;
        }
    }

    private boolean verified(String origin) {
        Long until = verifiedUntil.get(origin);
        if (until != null && until > now()) return true;
        if (instance == null) return false;
        int verdict = challenge(origin);
        if (verdict == SAME) {
            verifiedUntil.put(origin, now() + VERIFIED_MS);
            refused.remove(origin);
            untrusted.remove(origin);
            return true;
        }
        verifiedUntil.remove(origin);
        if (verdict == DIFFERENT) refused.add(origin);
        else if (verdict == CERTIFICATE) untrusted.add(origin);
        else untrusted.remove(origin);
        return false;
    }

    private List<String> order() {
        Set<String> order = new LinkedHashSet<>();
        if (!current.equals(primary) && heldUntil > now()) order.add(current);
        order.add(primary);
        order.addAll(alternates);
        return new ArrayList<>(order);
    }

    private void settle(String origin) {
        if (origin.equals(primary)) {
            current = primary;
            heldUntil = 0;
        } else if (!origin.equals(current) || heldUntil <= now()) {
            current = origin;
            heldUntil = now() + HOLD_MS;
        }
    }

    /**
     * Sends {@code path} to the address that answers: the one held, the usual one, then each proven alternate.
     * Any real answer, a 401 included, is returned as it is; only a network failure or a gateway moves on.
     */
    synchronized Reply request(String method, String path, String body, String token) throws IOException {
        IOException firstFailure = null;
        Reply lastGateway = null;
        for (String origin : order()) {
            if (!origin.equals(primary) && !verified(origin)) continue;
            try {
                Reply reply = transport.send(method, origin + path, body, token);
                if (isGatewayFailure(reply.status)) {
                    lastGateway = reply;
                    if (!origin.equals(primary)) verifiedUntil.remove(origin);
                    continue;
                }
                settle(origin);
                return reply;
            } catch (IOException failure) {
                if (!origin.equals(primary)) verifiedUntil.remove(origin);
                if (firstFailure == null) firstFailure = failure;
            }
        }
        if (lastGateway != null) return lastGateway;
        throw firstFailure != null ? firstFailure : new IOException("No address answered");
    }

    synchronized String origin() {
        return current;
    }

    synchronized boolean local() {
        return !current.equals(primary);
    }

    synchronized List<String> refused() {
        return new ArrayList<>(refused);
    }

    synchronized List<String> untrusted() {
        return new ArrayList<>(untrusted);
    }
}
