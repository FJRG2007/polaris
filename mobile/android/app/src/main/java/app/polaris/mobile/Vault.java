package app.polaris.mobile;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * The phone's connection to the Polaris Vault: connecting (approved from the dashboard, inside this app), keeping the
 * encrypted copy in step, and opening it for a fill or a save.
 */
final class Vault {
    private static final String TAG = "PolarisVault";
    /** A copy older than this is refreshed in the background the next time something asks to be filled. */
    private static final long STALE_MS = 5 * 60 * 1000L;

    static final ExecutorService WORK = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private Vault() {
    }

    /** The vault, opened. */
    static final class Opened {
        final VaultCrypto.Key key;
        final Map<String, VaultCrypto.Key> organizations;
        final List<VaultItems.Login> logins;

        Opened(VaultCrypto.Key key, Map<String, VaultCrypto.Key> organizations, List<VaultItems.Login> logins) {
            this.key = key;
            this.organizations = organizations;
            this.logins = logins;
        }

        VaultCrypto.Key keyFor(VaultItems.Login login) {
            return login.organizationId == null ? key : organizations.get(login.organizationId);
        }
    }

    static Opened open(Context context) throws VaultStore.Locked, VaultStore.Lost {
        VaultCrypto.Key key = VaultStore.key(context);
        JSONObject sync = VaultStore.readSync(context);
        String privateKey = VaultStore.prefs(context).getString("privateKey", null);
        if (sync == null) return new Opened(key, Collections.emptyMap(), Collections.emptyList());
        return new Opened(key, VaultItems.organizationKeys(sync, privateKey, key),
                VaultItems.open(sync, privateKey, key));
    }

    /** Refresh the copy off the main thread when it is old. Needs no key: what arrives is still encrypted. */
    static void syncIfStale(Context context) {
        if (!VaultStore.connected(context)) return;
        if (System.currentTimeMillis() - VaultStore.lastSync(context) < STALE_MS) return;
        syncNow(context, null);
    }

    /** What a sync came to, for the screen that asked. */
    interface Done {
        void done(boolean ok, boolean ended);
    }

    static void syncNow(Context context, Done done) {
        Context app = context.getApplicationContext();
        WORK.execute(() -> {
            boolean ok = false;
            boolean ended = false;
            try {
                VaultClient.sync(app);
                ok = true;
            } catch (VaultClient.Ended e) {
                // The server ended this phone's session (signed out from the dashboard, or the refresh was spent).
                ended = true;
                VaultStore.disconnect(app);
            } catch (IOException e) {
                Log.w(TAG, "sync failed", e);
            }
            boolean okFinal = ok;
            boolean endedFinal = ended;
            if (done != null) MAIN.post(() -> done.done(okFinal, endedFinal));
        });
    }

    // ---- Connecting: the request waits here, in the process, so leaving the screen to approve never drops it. ----

    enum Stage { IDLE, WAITING, APPROVED, DENIED, EXPIRED, FAILED }

    private static Stage stage = Stage.IDLE;
    private static String userCode;
    private static String deviceCode;
    private static String linkOrigin;
    private static KeyPair pair;
    private static long until;
    private static long pollMs = 2000;
    /** Collected and decrypted, waiting for the owner to prove who they are so it can be sealed. */
    private static VaultCrypto.Key pendingKey;
    private static VaultClient.Token pendingToken;
    private static Runnable listener;

    static synchronized Stage stage() {
        return stage;
    }

    static synchronized void listen(Runnable change) {
        listener = change;
    }

    private static void changed() {
        Runnable call;
        synchronized (Vault.class) {
            call = listener;
        }
        if (call != null) MAIN.post(call);
    }

    /** Ask the vault to let this phone in; answers the page that approves it, or null when the server did not answer. */
    interface Opening {
        void opened(String approvePage);
    }

    static void startConnect(Context context, String origin, Opening opening) {
        Context app = context.getApplicationContext();
        WORK.execute(() -> {
            String page = null;
            try {
                KeyPair fresh = VaultCrypto.generateRsa();
                VaultClient.Reply reply = VaultClient.form(app, VaultClient.base(origin) + "/identity/connect/authorize",
                        VaultClient.fields(
                                "publicKey", VaultCrypto.publicKeyBase64(fresh.getPublic()),
                                "deviceIdentifier", VaultStore.deviceId(app),
                                "deviceName", VaultClient.deviceName(),
                                "deviceType", String.valueOf(VaultClient.DEVICE_ANDROID)));
                JSONObject body = reply.ok() ? reply.json() : null;
                if (body != null && !body.optString("userCode").isEmpty() && !body.optString("deviceCode").isEmpty()) {
                    synchronized (Vault.class) {
                        pair = fresh;
                        userCode = body.optString("userCode");
                        deviceCode = body.optString("deviceCode");
                        linkOrigin = origin;
                        long poll = body.optLong("pollMs", 2000);
                        pollMs = Math.min(Math.max(poll, 1000), 30000);
                        until = System.currentTimeMillis() + 15 * 60 * 1000L;
                        stage = Stage.WAITING;
                    }
                    page = origin + "/vault/authorize?code=" + java.net.URLEncoder.encode(userCode, "UTF-8");
                    new Thread(() -> collect(app), "vault-link").start();
                }
            } catch (IOException | GeneralSecurityException e) {
                Log.w(TAG, "authorize failed", e);
            }
            String answer = page;
            MAIN.post(() -> opening.opened(answer));
            changed();
        });
    }

    static synchronized void cancelConnect() {
        stage = Stage.IDLE;
        pair = null;
        deviceCode = null;
        pendingKey = null;
        pendingToken = null;
    }

    /** Poll until approved, refused or out of time. Unreachable, 429 and 5xx keep waiting, as the extension does. */
    private static void collect(Context app) {
        while (true) {
            String code;
            String origin;
            long wait;
            synchronized (Vault.class) {
                if (stage != Stage.WAITING || deviceCode == null) return;
                if (System.currentTimeMillis() > until) {
                    stage = Stage.EXPIRED;
                    changed();
                    return;
                }
                code = deviceCode;
                origin = linkOrigin;
                wait = pollMs;
            }
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                return;
            }
            VaultClient.Reply reply;
            try {
                reply = VaultClient.form(app, VaultClient.base(origin) + "/identity/connect/authorize/claim",
                        VaultClient.fields("deviceCode", code));
            } catch (IOException e) {
                continue;
            }
            if (reply.status == 429 || reply.status >= 500) continue;
            JSONObject body = reply.ok() ? reply.json() : null;
            String status = body == null ? "expired" : body.optString("status");
            if ("pending".equals(status)) continue;
            synchronized (Vault.class) {
                if (stage != Stage.WAITING || !code.equals(deviceCode)) return;
                if ("approved".equals(status)) {
                    VaultClient.Token token = VaultClient.readToken(body);
                    byte[] raw = pair == null ? null
                            : VaultCrypto.decryptRsa(body.optString("wrappedKey"), pair.getPrivate());
                    pair = null;
                    if (token == null || raw == null || raw.length != 64) {
                        stage = Stage.FAILED;
                    } else {
                        pendingKey = VaultCrypto.Key.of(raw);
                        java.util.Arrays.fill(raw, (byte) 0);
                        pendingToken = token;
                        stage = Stage.APPROVED;
                    }
                } else {
                    stage = "denied".equals(status) ? Stage.DENIED : Stage.EXPIRED;
                }
            }
            changed();
            // Back to the vault screen, which the approval page replaced: it seals the key, or says what went wrong.
            MAIN.post(() -> {
                try {
                    app.startActivity(new android.content.Intent(app, VaultActivity.class)
                            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                                    | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP));
                } catch (RuntimeException e) {
                    Log.w(TAG, "could not return to the vault screen", e);
                }
            });
            return;
        }
    }

    /** Seal what an approval carried. Throws Locked when the owner has to prove who they are first. */
    static void finishConnect(Context context) throws VaultStore.Locked, GeneralSecurityException, IOException {
        VaultCrypto.Key key;
        VaultClient.Token token;
        String origin;
        synchronized (Vault.class) {
            if (stage != Stage.APPROVED) return;
            key = pendingKey;
            token = pendingToken;
            origin = linkOrigin;
        }
        VaultStore.connect(context, origin, token, key);
        synchronized (Vault.class) {
            stage = Stage.IDLE;
            pendingKey = null;
            pendingToken = null;
        }
        syncNow(context, null);
    }

    static synchronized String userCode() {
        return userCode;
    }
}
