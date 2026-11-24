package app.polaris.mobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The servers this phone keeps, managed from the page's Settings > This app > Hosts (`phoneHosts` in the dashboard's
 * `lib/mobile-bridge.ts`), the way the desktop app's are. Every answer has the shape the desktop app gives for the same
 * call, so the page reads both with one set of readers. Every address is checked with the same probe as
 * `ServerActivity`, and only hosts already on the list are switched to, edited or removed.
 */
final class PageHosts {
    /** Changes, one at a time: two changes to the list never race. */
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();
    /** Questions that only probe (a typed address, whether a host answers), a few at once, so a slow host never holds
     *  a change up behind it. */
    private static final ExecutorService PROBES = Executors.newFixedThreadPool(4);

    /** Where one call's answer goes, as JSON. */
    interface Answer {
        void send(String json);
    }

    private PageHosts() {
    }

    /** Runs one call off the main thread; an op this does not know answers null. */
    static void call(HomeActivity activity, String op, JSONObject args, Answer answer) {
        boolean probe = "status".equals(op) || "check".equals(op);
        (probe ? PROBES : WORKER).execute(() -> {
            Object out;
            try {
                out = run(activity, op, args);
            } catch (Exception failed) {
                out = null;
            }
            answer.send(out == null ? "null" : out instanceof String ? JSONObject.quote((String) out) : out.toString());
        });
    }

    private static Object run(HomeActivity activity, String op, JSONObject args) throws JSONException {
        switch (op) {
            case "list":
                return list(activity);
            case "check":
                return check(activity, args.optString("address"));
            case "add":
                return add(activity, args.optString("address"), args.optString("name"));
            case "switch":
                return switchTo(activity, args.optString("origin"));
            case "edit":
                return edit(activity, args.optString("origin"), args.optString("address"), args.optString("name"));
            case "remove":
                return remove(activity, args.optString("origin"));
            case "status":
                return status(activity, args.optString("origin"));
            case "link":
                return HostList.link(entries(activity));
            case "copy":
                return copy(activity);
            case "export":
                return export(activity);
            case "import":
                return importText(activity, args.optString("text"));
            default:
                return null;
        }
    }

    private static JSONObject list(HomeActivity activity) throws JSONException {
        ServerStore.Host active = ServerStore.active(activity);
        JSONArray servers = new JSONArray();
        for (ServerStore.Host host : ServerStore.all(activity)) {
            String hostname = Uri.parse(host.origin).getHost();
            servers.put(new JSONObject()
                    .put("origin", host.origin)
                    .put("name", host.name == null || host.name.isEmpty() ? JSONObject.NULL : host.name)
                    .put("host", hostname != null ? hostname : host.origin)
                    .put("active", active != null && active.id.equals(host.id)));
        }
        return new JSONObject().put("servers", servers).put("error", JSONObject.NULL);
    }

    private static JSONObject check(HomeActivity activity, String address) throws JSONException {
        String origin = ServerAddress.origin(address);
        if (origin == null) return checked(false, activity.getString(R.string.server_invalid));
        ServerProbe.Verdict verdict = ServerProbe.probe(origin);
        if (verdict == ServerProbe.Verdict.POLARIS) return checked(true, null);
        return checked(false, activity.getString(ServerActivity.reason(verdict)));
    }

    private static JSONObject checked(boolean ok, String message) throws JSONException {
        return new JSONObject().put("ok", ok).put("message", message == null ? JSONObject.NULL : message);
    }

    /** Keeps a new host after checking it; the one open stays open, as on the desktop. */
    private static JSONObject add(HomeActivity activity, String address, String name) throws JSONException {
        String origin = ServerAddress.origin(address);
        if (origin == null) return refused(activity.getString(R.string.server_invalid));
        if (find(activity, origin) != null) return refused(activity.getString(R.string.hosts_taken));
        String problem = probeProblem(activity, origin);
        if (problem != null) return refused(problem);
        ServerStore.Host before = ServerStore.active(activity);
        ServerStore.Host added = ServerStore.add(activity, origin);
        if (before != null) ServerStore.select(activity, before.id);
        String typed = cleanName(name);
        if (!typed.isEmpty()) ServerStore.rename(activity, added.id, typed);
        return done();
    }

    private static JSONObject switchTo(HomeActivity activity, String origin) throws JSONException {
        ServerStore.Host host = find(activity, origin);
        if (host == null) return refused("");
        ServerStore.Host active = ServerStore.active(activity);
        if (active != null && active.id.equals(host.id)) return done();
        ServerStore.select(activity, host.id);
        activity.runOnUiThread(() -> HomeActivity.reopen(activity));
        return done();
    }

    /** Address and name together. A new address is checked to be a Polaris before it is kept. */
    private static JSONObject edit(HomeActivity activity, String origin, String address, String name)
            throws JSONException {
        ServerStore.Host host = find(activity, origin);
        if (host == null) return refused("");
        String next = ServerAddress.origin(address);
        if (next == null) return refused(activity.getString(R.string.server_invalid));
        String typed = cleanName(name);
        String old = host.name != null ? host.name : "";
        if (!next.equals(host.origin)) {
            ServerStore.Host other = find(activity, next);
            if (other != null) return refused(activity.getString(R.string.hosts_taken));
            String problem = probeProblem(activity, next);
            if (problem != null) return refused(problem);
            if (!ServerStore.changeAddress(activity, host.id, next)) {
                return refused(activity.getString(R.string.hosts_taken));
            }
        }
        if (!typed.equals(old)) ServerStore.rename(activity, host.id, typed);
        ServerStore.Host active = ServerStore.active(activity);
        // The window open now is on the old address: reopen it on the new one.
        if (!next.equals(host.origin) && active != null && active.id.equals(host.id)) {
            activity.runOnUiThread(() -> HomeActivity.reopen(activity));
        }
        return done();
    }

    /** Signs the phone out of a host and forgets it; removing the one open opens another, or asks for one. */
    private static JSONObject remove(HomeActivity activity, String origin) throws JSONException {
        ServerStore.Host host = find(activity, origin);
        if (host == null) return refused("");
        ServerStore.Host active = ServerStore.active(activity);
        boolean current = active != null && active.id.equals(host.id);
        activity.runOnUiThread(() -> {
            HostProfiles.clear(host);
            ServerStore.remove(activity, host.id);
            if (!current) return;
            if (ServerStore.active(activity) != null) {
                HomeActivity.reopen(activity);
            } else {
                activity.stopService(new Intent(activity, NoticeService.class));
                activity.startActivity(new Intent(activity, ServerActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            }
        });
        return done();
    }

    /** "online" for a Polaris that answers (or is starting), "offline" for anything else. Listed hosts only. */
    private static String status(HomeActivity activity, String origin) {
        if (find(activity, origin) == null) return "unknown";
        ServerProbe.Verdict verdict = ServerProbe.probe(origin);
        return verdict == ServerProbe.Verdict.POLARIS || verdict == ServerProbe.Verdict.STARTING ? "online" : "offline";
    }

    private static JSONObject copy(HomeActivity activity) throws JSONException {
        List<HostList.Entry> entries = entries(activity);
        if (entries.isEmpty()) return new JSONObject().put("ok", false).put("count", 0);
        String code = HostList.encode(entries);
        activity.runOnUiThread(() -> {
            ClipboardManager clipboard = activity.getSystemService(ClipboardManager.class);
            if (clipboard == null) return;
            clipboard.setPrimaryClip(ClipData.newPlainText(activity.getString(R.string.hosts_export_subject), code));
        });
        return new JSONObject().put("ok", true).put("count", Math.min(entries.size(), HostList.MAX));
    }

    /**
     * The code through the share sheet, where Files saves it as a file and a chat or mail carries it. Whether somebody
     * finished sharing is not known here, so the answer is the desktop's "cancelled" one, which the page says nothing
     * about.
     */
    private static JSONObject export(HomeActivity activity) throws JSONException {
        List<HostList.Entry> entries = entries(activity);
        if (entries.isEmpty()) return new JSONObject().put("ok", false).put("error", JSONObject.NULL);
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_SUBJECT, activity.getString(R.string.hosts_export_subject))
                .putExtra(Intent.EXTRA_TEXT, HostList.encode(entries));
        activity.runOnUiThread(() ->
                activity.startActivity(Intent.createChooser(send, activity.getString(R.string.hosts_export_title))));
        return new JSONObject().put("ok", false).put("error", JSONObject.NULL);
    }

    /** Takes in the hosts a pasted, scanned or opened code holds, the same way a scanned QR is. */
    private static JSONObject importText(HomeActivity activity, String text) throws JSONException {
        List<HostList.Entry> hosts = HostList.read(text);
        if (hosts == null) {
            return new JSONObject().put("ok", false).put("error", activity.getString(R.string.link_hosts_invalid));
        }
        int[] counts = ServerStore.importHosts(activity, hosts);
        return new JSONObject().put("ok", true).put("added", counts[0]).put("named", counts[1]).put("skipped", counts[2]);
    }

    private static List<HostList.Entry> entries(HomeActivity activity) {
        List<HostList.Entry> entries = new ArrayList<>();
        for (ServerStore.Host host : ServerStore.all(activity)) entries.add(new HostList.Entry(host.origin, host.name));
        return entries;
    }

    /** The listed host at exactly this origin, or null: the page can only name hosts already on the list. */
    private static ServerStore.Host find(HomeActivity activity, String origin) {
        if (origin == null || origin.isEmpty()) return null;
        for (ServerStore.Host host : ServerStore.all(activity)) {
            if (host.origin.equals(origin)) return host;
        }
        return null;
    }

    /** Null when a Polaris answers at the origin, else why not, in words. */
    private static String probeProblem(HomeActivity activity, String origin) {
        ServerProbe.Verdict verdict = ServerProbe.probe(origin);
        return verdict == ServerProbe.Verdict.POLARIS ? null : activity.getString(ServerActivity.reason(verdict));
    }

    private static String cleanName(String name) {
        String typed = name == null ? "" : name.replaceAll("\\s+", " ").trim();
        return typed.length() > HostList.NAME_MAX ? typed.substring(0, HostList.NAME_MAX) : typed;
    }

    private static JSONObject done() throws JSONException {
        return new JSONObject().put("ok", true);
    }

    private static JSONObject refused(String error) throws JSONException {
        return new JSONObject().put("ok", false).put("error", error);
    }
}
