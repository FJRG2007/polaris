package app.polaris.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.service.quicksettings.TileService;
import android.content.ComponentName;
import com.wireguard.android.backend.BackendException;
import com.wireguard.android.backend.GoBackend;
import com.wireguard.android.backend.Statistics;
import com.wireguard.android.backend.Tunnel;
import com.wireguard.config.Config;
import com.wireguard.config.Interface;
import com.wireguard.config.Peer;
import com.wireguard.crypto.Key;
import com.wireguard.crypto.KeyPair;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * This phone's VPN: one tunnel, run by the app itself through the WireGuard tunnel library (the same `GoBackend` the
 * official WireGuard app runs). The page asks Polaris for a place and hands the answer over ({@link #up}); the Quick
 * Settings tile reconnects to the last place without the page, asking Polaris again first so a person whose access
 * ended is told so instead of getting a tunnel that never answers.
 *
 * The private key is made here and never leaves the phone: Polaris only ever sees the public half. It is kept in the
 * app's private storage, as the official app keeps its configurations, and backups are off for this app.
 */
final class VpnTunnel {
    /** How an attempt ended: null when it worked, else a code the page and the tile both put in words. */
    interface Done {
        void done(String error);
    }

    /** Told whenever the tunnel goes up or down. */
    interface Listener {
        void changed();
    }

    static final String DENIED = "denied";
    static final String FAILED = "failed";
    static final String NO_ANSWER = "noAnswer";
    static final String UNREACHABLE = "unreachable";
    /** Not signed in to the Polaris the tunnel belongs to, or no place picked yet: the tile opens the app. */
    static final String SIGN_IN = "signIn";
    static final String NO_PLACE = "noPlace";
    static final String NO_ACCESS = "noAccess";

    private static final String PREFS = "vpn";
    private static final int KEEPALIVE_SECONDS = 25;
    /** How long a new tunnel has to hear from the server before it counts as not answering. */
    private static final long HANDSHAKE_WAIT_MS = 12_000;
    private static VpnTunnel instance;

    private final Context context;
    private final GoBackend backend;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Listener> listeners = new ArrayList<>();
    private final Session session = new Session();
    /** The place the tunnel is up to, null while it is down. */
    private volatile String nodeId;

    /** The tunnel the library drives; one name, so a reconnect replaces it instead of adding another. */
    private final class Session implements Tunnel {
        @Override
        public String getName() {
            return "polaris";
        }

        @Override
        public void onStateChange(Tunnel.State state) {
            if (state == Tunnel.State.DOWN) {
                nodeId = null;
            }
            changed();
        }
    }

    private VpnTunnel(Context context) {
        this.context = context.getApplicationContext();
        backend = new GoBackend(this.context);
        // Android's own "Always-on VPN" starts the service with no page behind it: back to the last place.
        GoBackend.setAlwaysOnCallback(() -> reconnect(null));
    }

    /** One per app: the library's VPN service belongs to a single backend. */
    static synchronized VpnTunnel get(Context context) {
        if (instance == null) instance = new VpnTunnel(context);
        return instance;
    }

    /** What this phone calls itself on the device list. */
    static String deviceName(Context context) {
        String name = null;
        try {
            name = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME);
        } catch (RuntimeException ignored) {
            // Some phones keep no name there; the model is enough.
        }
        if (name == null || name.trim().isEmpty()) name = Build.MANUFACTURER + " " + Build.MODEL;
        name = name.replaceAll("\\p{Cntrl}", " ").trim();
        return name.length() > 40 ? name.substring(0, 40).trim() : name;
    }

    /** The public half of this phone's key for `origin`, made the first time it is asked for; null if it cannot be. */
    synchronized String publicKey(String origin) {
        try {
            return keyPair(origin).getPublicKey().toBase64();
        } catch (RuntimeException failed) {
            return null;
        }
    }

    private KeyPair keyPair(String origin) {
        SharedPreferences prefs = prefs();
        String stored = prefs.getString("key:" + origin, null);
        if (stored != null) {
            try {
                return new KeyPair(Key.fromBase64(stored));
            } catch (Exception broken) {
                // Unreadable: a new one below, and Polaris adds it as a new device.
            }
        }
        KeyPair made = new KeyPair();
        prefs.edit().putString("key:" + origin, made.getPrivateKey().toBase64()).commit();
        return made;
    }

    /** The place the tunnel is up to, or null. */
    String nodeId() {
        return nodeId;
    }

    /** Whether there is a last place the tile can reconnect to. */
    boolean hasLast() {
        return prefs().getString("last", null) != null;
    }

    /** As the page reads it. */
    String statusJson() {
        try {
            return new JSONObject().put("nodeId", nodeId == null ? JSONObject.NULL : nodeId).toString();
        } catch (JSONException impossible) {
            return "{\"nodeId\":null}";
        }
    }

    void listen(Listener listener) {
        synchronized (listeners) {
            listeners.add(listener);
        }
    }

    void unlisten(Listener listener) {
        synchronized (listeners) {
            listeners.remove(listener);
        }
    }

    private void changed() {
        main.post(() -> {
            List<Listener> now;
            synchronized (listeners) {
                now = new ArrayList<>(listeners);
            }
            for (Listener listener : now) listener.changed();
            TileService.requestListeningState(context, new ComponentName(context, VpnTile.class));
        });
    }

    /**
     * Up to the place the page connected this phone to: `input` is what Polaris answered (address, DNS, the server's
     * key and endpoint), and `own` when it is a VPN from elsewhere, with keys of its own. Consent is the caller's to
     * have asked for; without it this ends in {@link #DENIED}.
     */
    void up(String origin, JSONObject input, Done done) {
        worker.execute(() -> finish(done, start(origin, input)));
    }

    void down(Done done) {
        worker.execute(() -> {
            String error = null;
            try {
                backend.setState(session, Tunnel.State.DOWN, null);
            } catch (Exception failed) {
                error = FAILED;
            }
            nodeId = null;
            changed();
            finish(done, error);
        });
    }

    /**
     * Back to the last place, from the tile or Always-on VPN. A Polaris place is asked for again first, signed in as
     * the page is, so a person whose access ended hears that; a VPN from elsewhere goes up as it was.
     */
    void reconnect(Done done) {
        worker.execute(() -> finish(done, again()));
    }

    private String again() {
        String last = prefs().getString("last", null);
        if (last == null) return NO_PLACE;
        if (VpnService.prepare(context) != null) return DENIED;
        try {
            JSONObject saved = new JSONObject(last);
            String origin = saved.getString("origin");
            JSONObject input = saved.getJSONObject("input");
            if (input.has("own") && !input.isNull("own")) return start(origin, input);
            JSONObject ask = new JSONObject()
                    .put("nodeId", input.getString("nodeId"))
                    .put("name", deviceName(context))
                    .put("publicKey", keyPair(origin).getPublicKey().toBase64());
            PolarisHttp.Answer answer = PolarisHttp.request(context, origin + "/api/mobile/vpn", "POST", ask.toString(), 64 * 1024);
            if (answer.status == 401) return SIGN_IN;
            if (answer.status == 403) return NO_ACCESS;
            if (answer.status >= 300) {
                String code = codeOf(answer);
                return code.isEmpty() ? FAILED : code;
            }
            JSONObject fresh = answer.json();
            fresh.put("nodeId", input.getString("nodeId"));
            return start(origin, fresh);
        } catch (IOException offline) {
            return UNREACHABLE;
        } catch (Exception broken) {
            return FAILED;
        }
    }

    private static String codeOf(PolarisHttp.Answer answer) {
        try {
            String code = answer.json().optString("error", "");
            return code.matches("[a-zA-Z]{1,40}") ? code : "";
        } catch (JSONException notJson) {
            return "";
        }
    }

    private String start(String origin, JSONObject input) {
        if (VpnService.prepare(context) != null) return DENIED;
        String node;
        Config config;
        Key peerKey;
        try {
            node = input.getString("nodeId");
            config = configOf(origin, input);
            peerKey = config.getPeers().get(0).getPublicKey();
        } catch (Exception bad) {
            return FAILED;
        }
        try {
            backend.setState(session, Tunnel.State.UP, config);
        } catch (BackendException refused) {
            return refused.getReason() == BackendException.Reason.VPN_NOT_AUTHORIZED ? DENIED
                    : refused.getReason() == BackendException.Reason.DNS_RESOLUTION_FAILURE ? UNREACHABLE
                    : FAILED;
        } catch (Exception failed) {
            return FAILED;
        }
        if (!answered(peerKey)) {
            try {
                backend.setState(session, Tunnel.State.DOWN, null);
            } catch (Exception ignored) {
                // Already down.
            }
            nodeId = null;
            changed();
            return NO_ANSWER;
        }
        nodeId = node;
        try {
            JSONObject saved = new JSONObject().put("origin", origin).put("input", input);
            prefs().edit().putString("last", saved.toString()).apply();
        } catch (JSONException ignored) {
            // The tunnel is up; only the tile's memory of it is missing.
        }
        changed();
        return null;
    }

    /** Whether the server shook hands within the wait: connecting means it answers, not only that a tunnel exists. */
    private boolean answered(Key peerKey) {
        long until = System.currentTimeMillis() + HANDSHAKE_WAIT_MS;
        while (System.currentTimeMillis() < until) {
            try {
                Statistics stats = backend.getStatistics(session);
                Statistics.PeerStats peer = stats.peer(peerKey);
                if (peer != null && peer.latestHandshakeEpochMillis() > 0) return true;
                Thread.sleep(500);
            } catch (InterruptedException stop) {
                Thread.currentThread().interrupt();
                return false;
            } catch (Exception notYet) {
                // The library has nothing to say yet; ask again.
                try {
                    Thread.sleep(500);
                } catch (InterruptedException stop) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        return false;
    }

    /** The tunnel's configuration from what Polaris answered. */
    private Config configOf(String origin, JSONObject input) throws Exception {
        JSONObject own = input.has("own") && !input.isNull("own") ? input.getJSONObject("own") : null;
        KeyPair keys = own != null ? new KeyPair(Key.fromBase64(own.getString("privateKey"))) : keyPair(origin);
        Interface.Builder face = new Interface.Builder().setKeyPair(keys);
        face.parseAddresses(withPrefix(input.getString("address")));
        if (own != null) {
            JSONArray more = own.optJSONArray("moreAddresses");
            for (int i = 0; more != null && i < more.length(); i++) face.parseAddresses(withPrefix(more.getString(i)));
            if (own.has("mtu") && !own.isNull("mtu")) face.parseMtu(String.valueOf(own.getInt("mtu")));
        }
        JSONArray dns = input.optJSONArray("dns");
        if (dns != null && dns.length() > 0) face.parseDnsServers(join(dns));
        Peer.Builder peer = new Peer.Builder()
                .parsePublicKey(input.getString("nodePublicKey"))
                .parseEndpoint(endpoint(input.getString("endpoint"), input.getInt("port")))
                .setPersistentKeepalive(KEEPALIVE_SECONDS);
        JSONArray allowed = own != null ? own.optJSONArray("allowedIps") : null;
        peer.parseAllowedIPs(allowed != null && allowed.length() > 0 ? join(allowed) : "0.0.0.0/0, ::/0");
        if (own != null && own.has("presharedKey") && !own.isNull("presharedKey")) {
            peer.parsePreSharedKey(own.getString("presharedKey"));
        }
        return new Config.Builder().setInterface(face.build()).addPeer(peer.build()).build();
    }

    static String withPrefix(String address) {
        if (address.contains("/")) return address;
        return address + (address.contains(":") ? "/128" : "/32");
    }

    static String endpoint(String host, int port) {
        boolean bareIpv6 = host.contains(":") && !host.startsWith("[");
        return (bareIpv6 ? "[" + host + "]" : host) + ":" + port;
    }

    private static String join(JSONArray values) throws JSONException {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < values.length(); i++) {
            if (i > 0) out.append(", ");
            out.append(values.getString(i));
        }
        return out.toString();
    }

    private void finish(Done done, String error) {
        if (done != null) main.post(() -> done.done(error));
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
