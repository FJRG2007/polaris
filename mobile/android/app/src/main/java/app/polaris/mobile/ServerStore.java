package app.polaris.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Every Polaris this phone opens, and the one it opens now, kept between launches.
 *
 * Each one has its own WebView profile (its own cookies and storage, see {@link HostProfiles}) so being signed in to
 * one never signs anybody in or out of another. The Polaris kept before there was a list becomes the host "default"
 * on the WebView's default profile, which is where its session already lives.
 */
final class ServerStore {
    private static final String FILE = "server";
    /** Before the list: the one origin. Read once, to migrate it. */
    private static final String LEGACY_ORIGIN = "origin";
    private static final String HOSTS = "hosts";
    private static final String ACTIVE = "active";
    /** Profiles of removed hosts, deleted the next time the app starts (a profile in use cannot be deleted). */
    private static final String DOOMED = "doomed_profiles";
    static final String DEFAULT_ID = "default";

    /** One Polaris. `profile` is null for the WebView's default profile. */
    static final class Host {
        final String id;
        final String origin;
        final String name;
        final String profile;

        Host(String id, String origin, String name, String profile) {
            this.id = id;
            this.origin = origin;
            this.name = name;
            this.profile = profile;
        }

        /** What the list shows: the name given to it, else its address without the scheme. */
        String label() {
            if (name != null && !name.isEmpty()) return name;
            String host = Uri.parse(origin).getHost();
            return host != null ? host : origin;
        }
    }

    private ServerStore() {
    }

    /** The address of the Polaris open now, or null before there is one. */
    static String origin(Context context) {
        Host host = active(context);
        return host == null ? null : host.origin;
    }

    static synchronized Host active(Context context) {
        List<Host> hosts = read(context);
        String id = prefs(context).getString(ACTIVE, null);
        for (Host host : hosts) {
            if (host.id.equals(id)) return host;
        }
        return hosts.isEmpty() ? null : hosts.get(0);
    }

    static synchronized List<Host> all(Context context) {
        return Collections.unmodifiableList(read(context));
    }

    /** The host an address belongs to, else the one open now: whose cookies a request to it carries. */
    static synchronized Host hostFor(Context context, String address) {
        for (Host host : read(context)) {
            if (ServerAddress.sameOrigin(host.origin, address)) return host;
        }
        return active(context);
    }

    /**
     * Adds a Polaris and makes it the one open now. An address already in the list is that host, not a second one:
     * two profiles for one origin would be two sign-ins to the same place.
     */
    static synchronized Host add(Context context, String origin) {
        List<Host> hosts = read(context);
        for (Host host : hosts) {
            if (host.origin.equals(origin)) {
                select(context, host.id);
                return host;
            }
        }
        String id = UUID.randomUUID().toString();
        // The first Polaris, or a WebView with no profiles: the default profile, shared (see HostProfiles).
        String profile = hosts.isEmpty() || !HostProfiles.separate() ? null : "host-" + id;
        Host added = new Host(hosts.isEmpty() ? DEFAULT_ID : id, origin, null, profile);
        hosts.add(added);
        write(context, hosts);
        select(context, added.id);
        return added;
    }

    static synchronized void select(Context context, String id) {
        prefs(context).edit().putString(ACTIVE, id).apply();
    }

    static synchronized void rename(Context context, String id, String name) {
        List<Host> hosts = read(context);
        for (int i = 0; i < hosts.size(); i++) {
            Host host = hosts.get(i);
            if (host.id.equals(id)) hosts.set(i, new Host(host.id, host.origin, name.trim(), host.profile));
        }
        write(context, hosts);
    }

    /** Forgets a host. Its cookies are cleared by the caller; its profile is deleted on the next start. */
    static synchronized void remove(Context context, String id) {
        List<Host> hosts = read(context);
        Set<String> doomed = new HashSet<>(prefs(context).getStringSet(DOOMED, Collections.emptySet()));
        for (int i = hosts.size() - 1; i >= 0; i--) {
            Host host = hosts.get(i);
            if (!host.id.equals(id)) continue;
            if (host.profile != null) doomed.add(host.profile);
            hosts.remove(i);
        }
        write(context, hosts);
        SharedPreferences.Editor editor = prefs(context).edit().putStringSet(DOOMED, doomed);
        if (id.equals(prefs(context).getString(ACTIVE, null))) {
            if (hosts.isEmpty()) editor.remove(ACTIVE);
            else editor.putString(ACTIVE, hosts.get(0).id);
        }
        editor.apply();
    }

    static synchronized Set<String> doomedProfiles(Context context) {
        return new HashSet<>(prefs(context).getStringSet(DOOMED, Collections.emptySet()));
    }

    static synchronized void profileDeleted(Context context, String profile) {
        Set<String> doomed = doomedProfiles(context);
        doomed.remove(profile);
        prefs(context).edit().putStringSet(DOOMED, doomed).apply();
    }

    private static List<Host> read(Context context) {
        SharedPreferences prefs = prefs(context);
        List<Host> hosts = new ArrayList<>();
        String stored = prefs.getString(HOSTS, null);
        if (stored == null) {
            String legacy = prefs.getString(LEGACY_ORIGIN, null);
            if (legacy != null) {
                hosts.add(new Host(DEFAULT_ID, legacy, null, null));
                write(context, hosts);
                prefs.edit().putString(ACTIVE, DEFAULT_ID).remove(LEGACY_ORIGIN).apply();
            }
            return hosts;
        }
        try {
            JSONArray list = new JSONArray(stored);
            for (int i = 0; i < list.length(); i++) {
                JSONObject item = list.getJSONObject(i);
                String origin = ServerAddress.origin(item.optString("origin", ""));
                if (origin == null) continue;
                String name = item.optString("name", "");
                String profile = item.optString("profile", "");
                hosts.add(new Host(item.getString("id"), origin, name.isEmpty() ? null : name,
                        profile.isEmpty() ? null : profile));
            }
        } catch (JSONException unreadable) {
            // Never written by this app in another shape; a list it cannot read is an empty one.
        }
        return hosts;
    }

    private static void write(Context context, List<Host> hosts) {
        JSONArray list = new JSONArray();
        try {
            for (Host host : hosts) {
                JSONObject item = new JSONObject().put("id", host.id).put("origin", host.origin);
                if (host.name != null) item.put("name", host.name);
                if (host.profile != null) item.put("profile", host.profile);
                list.put(item);
            }
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        prefs(context).edit().putString(HOSTS, list.toString()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
}
