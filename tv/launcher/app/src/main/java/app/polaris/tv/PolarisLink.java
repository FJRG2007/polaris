package app.polaris.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * This TV's connection to a Polaris, when it has one. Everything here is optional: with nothing stored
 * {@link #load} answers null and the launcher never opens a socket.
 *
 * The key sits sealed under the Android Keystore. Calls block, so they run off the main thread.
 */
final class PolarisLink {

    private static final String PREFS = "polaris";
    private static final String ASKED_AT = "instanceAskedAt";
    private static final String ACCOUNT_FIRST_NAME = "accountFirstName";
    private static final String ACCOUNT_LOCALE = "accountLocale";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "polaris-tv";
    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;
    private static final int MAX_BODY = 64 * 1024;
    private static final Pattern UUID = Pattern.compile(
            "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    /** Home asks at most this often, so a TV left on the launcher is not polling. */
    static final long STATE_MS = 5 * 60_000;

    /** Sends over HttpURLConnection, which follows the system's certificate trust. */
    static final PolarisFailover.Transport HTTP = http(PolarisFailover.TIMEOUT_MS, null);

    /**
     * The same transport, waiting up to {@code readTimeoutMs} for an answer. With a {@code localCa} scope, the
     * instance's local https addresses also accept a chain ending in its pinned local CA; every other address,
     * the usual one included, keeps the system's trust.
     */
    static PolarisFailover.Transport http(int readTimeoutMs, PolarisLocalCa.Scope localCa) {
        return (method, url, body, token) -> send(method, url, body, token, readTimeoutMs, localCa);
    }

    private static PolarisFailover.Reply send(String method, String url, String body, String token, int readTimeoutMs,
            PolarisLocalCa.Scope localCa) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            PolarisLocalCa.apply(connection, localCa);
            connection.setConnectTimeout(PolarisFailover.TIMEOUT_MS);
            connection.setReadTimeout(readTimeoutMs);
            connection.setRequestMethod(method);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "polaris-tv/" + BuildConfig.VERSION_NAME);
            if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            return new PolarisFailover.Reply(status, stream == null ? "" : read(stream), retryAfter(connection));
        } finally {
            connection.disconnect();
        }
    }

    /** Retry-After in seconds, or -1 when it is absent or a date. */
    static long retryAfter(HttpURLConnection connection) {
        String value = connection.getHeaderField("Retry-After");
        if (value == null) return -1;
        try {
            return Math.max(0, Long.parseLong(value.trim()));
        } catch (NumberFormatException httpDate) {
            return -1;
        }
    }

    private static String read(InputStream stream) throws IOException {
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            for (int size; (size = in.read(chunk)) != -1; ) {
                if (out.size() + size > MAX_BODY) throw new IOException("The answer is too long");
                out.write(chunk, 0, size);
            }
            return out.toString("UTF-8");
        }
    }

    /** What a pairing request answered. */
    static final class Pairing {
        final String userCode;
        final String deviceCode;
        final String approveUrl;
        final String verifyUrl;
        final long pollMs;
        final long expiresAt;

        Pairing(String userCode, String deviceCode, String approveUrl, String verifyUrl, long pollMs, long expiresAt) {
            this.userCode = userCode;
            this.deviceCode = deviceCode;
            this.approveUrl = approveUrl;
            this.verifyUrl = verifyUrl;
            this.pollMs = pollMs;
            this.expiresAt = expiresAt;
        }
    }

    /** What the instance tells a connected TV. */
    static final class State {
        final String instanceName;
        final String accountName;
        final int unread;
        final int alerts;
        /** An update asked for from Polaris, or null. */
        final String updateRequestId;
        final String updateRequestVersion;
        /** Block ads and trackers as asked from Polaris, or null when the TV keeps its own setting. */
        final Boolean desiredBlocking;
        /** The id of that choice, or null. */
        final String desiredChoice;
        /** The theme and add-ons picked from Polaris ({@link RemoteCatalog}), or null when none was. */
        final RemoteCatalog.Pick desiredTheme;
        final RemoteCatalog.Pick desiredAddons;
        /** Whether the account's language (kept with its first name, {@link #accountFirstName}) differs from the one this TV had kept, so screens redraw in it. */
        final boolean localeChanged;

        State(String instanceName, String accountName, int unread, int alerts, String updateRequestId,
                String updateRequestVersion, Boolean desiredBlocking, String desiredChoice,
                RemoteCatalog.Pick desiredTheme, RemoteCatalog.Pick desiredAddons, boolean localeChanged) {
            this.instanceName = instanceName;
            this.accountName = accountName;
            this.unread = unread;
            this.alerts = alerts;
            this.updateRequestId = updateRequestId;
            this.updateRequestVersion = updateRequestVersion;
            this.desiredBlocking = desiredBlocking;
            this.desiredChoice = desiredChoice;
            this.desiredTheme = desiredTheme;
            this.desiredAddons = desiredAddons;
            this.localeChanged = localeChanged;
        }
    }

    private final Context context;
    final String origin;
    private final String token;
    private final PolarisFailover.Instance instance;
    private final PolarisLocalCa.Scope localCa;
    private final PolarisFailover failover;
    private boolean relearned;

    private PolarisLink(Context context, String origin, String token, PolarisFailover.Instance instance) {
        this.context = context.getApplicationContext();
        this.origin = origin;
        this.token = token;
        this.instance = instance;
        this.localCa = PolarisLocalCa.scope(origin, instance);
        this.failover = new PolarisFailover(http(PolarisFailover.TIMEOUT_MS, localCa), origin, instance);
    }

    /** The stored connection, or null when this TV has none. */
    static PolarisLink load(Context context) {
        SharedPreferences prefs = prefs(context);
        String origin = prefs.getString("origin", null);
        String sealed = prefs.getString("token", null);
        if (origin == null || sealed == null) return null;
        String token = unseal(sealed);
        if (token == null) return null;
        return new PolarisLink(context, origin, token, instanceFrom(prefs.getString("instance", null)));
    }

    /** A string field, or null when it is missing, JSON null or not a string (optString would say "null"). */
    private static String text(JSONObject json, String name) {
        Object value = json.opt(name);
        return value instanceof String ? (String) value : null;
    }

    /** The linked account's first name as last heard, for the home greeting; "" when not linked or none. */
    static String accountFirstName(Context context) {
        return prefs(context).getString(ACCOUNT_FIRST_NAME, "");
    }

    /** The linked account's language tag as last heard; "" when not linked or it has none. Unlinking clears it. */
    static String accountLocale(Context context) {
        return prefs(context).getString(ACCOUNT_LOCALE, "");
    }

    /** Keeps what the instance said about the account; true when the language is not the one kept before. */
    private static boolean rememberAccount(Context context, String firstName, String locale) {
        SharedPreferences prefs = prefs(context);
        // Only while still linked: a poll answered after Disconnect must not write the account back.
        if (!prefs.contains("token")) return false;
        boolean changed = !locale.equals(prefs.getString(ACCOUNT_LOCALE, ""));
        prefs.edit().putString(ACCOUNT_FIRST_NAME, firstName).putString(ACCOUNT_LOCALE, locale).commit();
        return changed;
    }

    static boolean connected(Context context) {
        return prefs(context).contains("token");
    }

    private static SharedPreferences prefs(Context context) {
        // Read from attachBaseContext too (LauncherLocale via Config), where the application may not be attached yet.
        Context app = context.getApplicationContext();
        return (app != null ? app : context).getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static PolarisFailover.Instance instanceFrom(String stored) {
        return stored == null ? null : PolarisFailover.readInstance(stored);
    }

    /** Asks the instance to describe itself, over the address the person typed. Null on an older Polaris. */
    static String learn(String origin) {
        try {
            PolarisFailover.Reply reply = HTTP.send("GET", origin + PolarisFailover.INSTANCE_PATH, null, null);
            return reply.ok() && PolarisFailover.readInstance(reply.body) != null ? reply.body : null;
        } catch (IOException unreachable) {
            return null;
        }
    }

    /** Opens a pairing request. Throws IOException when the address does not answer as a Polaris. */
    static Pairing pair(String origin) throws IOException {
        try {
            JSONObject ask = new JSONObject().put("deviceName", deviceName()).put("clientVersion", BuildConfig.VERSION_NAME);
            PolarisFailover.Reply reply = HTTP.send("POST", origin + "/api/tv/authorize", ask.toString(), null);
            if (!reply.ok()) throw new IOException("Refused: " + reply.status);
            JSONObject answer = new JSONObject(reply.body);
            long pollMs = Math.max(2_000, answer.optLong("pollMs", 3_000));
            return new Pairing(answer.getString("userCode"), answer.getString("deviceCode"),
                    origin + answer.getString("approvePath"), origin + answer.getString("verificationPath"),
                    pollMs, java.time.Instant.parse(answer.getString("expiresAt")).toEpochMilli());
        } catch (JSONException | java.time.format.DateTimeParseException notPolaris) {
            throw new IOException("Not a Polaris", notPolaris);
        }
    }

    private static String deviceName() {
        String name = (Build.MANUFACTURER + " " + Build.MODEL).trim();
        return name.isEmpty() ? "TV" : name.substring(0, Math.min(name.length(), 80));
    }

    /** One look at a pairing: "pending", "denied", "expired", or "approved" with the connection stored. */
    static String claim(Context context, String origin, String instance, Pairing pairing) throws IOException {
        try {
            String ask = new JSONObject().put("deviceCode", pairing.deviceCode).toString();
            PolarisFailover.Reply reply = HTTP.send("POST", origin + "/api/tv/authorize/claim", ask, null);
            if (!reply.ok()) throw new IOException("Refused: " + reply.status);
            JSONObject answer = new JSONObject(reply.body);
            String status = answer.optString("status", "pending");
            if (!status.equals("approved")) return status;
            String sealed = seal(answer.getString("token"));
            if (sealed == null) throw new IOException("This TV could not store the sign-in");
            JSONObject account = answer.optJSONObject("account");
            String firstName = account == null ? "" : LinkedAccount.firstName(null, text(account, "name"));
            prefs(context).edit().putString("origin", origin).putString("token", sealed)
                    .putString("instance", instance).putLong(ASKED_AT, System.currentTimeMillis())
                    .putString(ACCOUNT_FIRST_NAME, firstName).commit();
            return status;
        } catch (JSONException notPolaris) {
            throw new IOException("Not a Polaris", notPolaris);
        }
    }

    /**
     * Asks the usual address again for the instance's record, at most once per link and as often as
     * {@link PolarisFailover#relearnDue} allows across links: a TV paired before its Polaris published a local CA
     * pin would otherwise keep sending its key over plain http on the local network, and a pinned TV would keep a
     * pin its Polaris replaced. The new record is kept only when it is the same instance and key and carries a pin;
     * it applies from the next load.
     */
    private void relearn() {
        if (relearned || PolarisFailover.plain(origin)) return;
        relearned = true;
        SharedPreferences prefs = prefs(context);
        long now = System.currentTimeMillis();
        boolean pinned = instance != null && !instance.localCaSha256.isEmpty();
        if (!PolarisFailover.relearnDue(pinned, prefs.getLong(ASKED_AT, 0), now)) return;
        prefs.edit().putLong(ASKED_AT, now).apply();
        String body = learn(origin);
        PolarisFailover.Instance fresh = body == null ? null : PolarisFailover.readInstance(body);
        if (fresh == null || fresh.localCaSha256.isEmpty()) return;
        if (instance != null && (!instance.id.equals(fresh.id) || !instance.publicKey.equals(fresh.publicKey))) return;
        prefs.edit().putString("instance", body).apply();
    }

    /**
     * What the instance says now. Null when the key is no longer accepted. Carries this build's version, which
     * is how Polaris knows what the TV runs and when an update it asked for has landed, and what came of Block ads
     * and trackers ({@link RemoteBlocking}) and of the theme and add-ons picked ({@link RemoteCatalog}).
     */
    State state() throws IOException {
        String path = RemoteCatalogRun.withReport(context, RemoteBlockingRun.withReport(context,
                "/api/tv/state" + SelfUpdate.versionQuery(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)));
        PolarisFailover.Reply reply = failover.request("GET", path, null, token);
        if (reply.status == 401) return null;
        if (!reply.ok()) throw new IOException("Refused: " + reply.status);
        if (!failover.local()) relearn();
        try {
            JSONObject answer = new JSONObject(reply.body);
            JSONObject instance = answer.getJSONObject("instance");
            JSONObject account = answer.getJSONObject("account");
            // Older instances leave updateRequest out; a malformed one is ignored rather than refused.
            JSONObject request = answer.optJSONObject("updateRequest");
            String requestId = request == null ? null : request.optString("id", "");
            if (requestId != null && !UUID.matcher(requestId).matches()) requestId = null;
            // firstName and locale are newer than the rest: an older instance leaves them out, and either may be null.
            String firstName = LinkedAccount.firstName(text(account, "firstName"), text(account, "name"));
            boolean localeChanged = rememberAccount(context, firstName, LinkedAccount.locale(text(account, "locale")));
            return new State(instance.optString("name"), account.optString("name"),
                    Math.max(0, answer.optInt("unread")), Math.max(0, answer.optInt("alerts")), requestId,
                    requestId == null ? null : request.optString("versionName", null),
                    RemoteBlocking.desiredBlocking(answer), RemoteBlocking.desiredChoice(answer),
                    RemoteCatalog.desiredTheme(answer), RemoteCatalog.desiredAddons(answer), localeChanged);
        } catch (JSONException notPolaris) {
            throw new IOException("Not a Polaris", notPolaris);
        }
    }

    /**
     * The hostname of the Network filter's encrypted DNS, when the instance publishes one and it answers. Null
     * when it has none (or is older than this question), so the person types a resolver of their own.
     */
    String networkFilterHostname() throws IOException {
        PolarisFailover.Reply reply = failover.request("GET", "/api/tv/network-filter", null, token);
        if (reply.status == 404) return null;
        if (!reply.ok()) throw new IOException("Refused: " + reply.status);
        try {
            JSONObject answer = new JSONObject(reply.body);
            if (!answer.optBoolean("available", false) || answer.isNull("dotHostname")) return null;
            return PrivateDns.normalize(answer.optString("dotHostname", null));
        } catch (JSONException notPolaris) {
            throw new IOException("Not a Polaris", notPolaris);
        }
    }

    /** The update routes over this TV's key, reaching the same addresses as the state poll, alternates included. */
    SelfUpdate.Net updateNet() {
        return new SelfUpdateRun.Http(
                new PolarisFailover(http(SelfUpdateRun.TIMEOUT_MS, localCa), origin, instance), localCa, token);
    }

    boolean onLocalAddress() {
        return failover.local();
    }

    String addressInUse() {
        return failover.origin();
    }

    List<String> refused() {
        return failover.refused();
    }

    List<String> untrusted() {
        return failover.untrusted();
    }

    /** Ends the sign-in on the instance when it can be reached, and on this TV whatever happens. */
    void disconnect() {
        try {
            failover.request("DELETE", "/api/tv/session", null, token);
        } catch (IOException unreachable) {
            // The key expires by itself, and the owner can end it from their account.
        }
        forget(context);
    }

    static void forget(Context context) {
        prefs(context).edit().clear().commit();
    }

    private static SecretKey key() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private static String seal(String token) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(sealed, 0, out, iv.length, sealed.length);
            return Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (GeneralSecurityException | IOException refused) {
            return null;
        }
    }

    private static String unseal(String stored) {
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, all, 0, GCM_IV_BYTES));
            return new String(cipher.doFinal(all, GCM_IV_BYTES, all.length - GCM_IV_BYTES), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IOException | IllegalArgumentException unreadable) {
            return null;
        }
    }

    /** The addresses as one line for the screen. */
    static String join(List<String> origins) {
        List<String> hosts = new ArrayList<>();
        for (String origin : origins) hosts.add(origin.replaceFirst("^https?://", ""));
        return String.join(", ", hosts);
    }
}
