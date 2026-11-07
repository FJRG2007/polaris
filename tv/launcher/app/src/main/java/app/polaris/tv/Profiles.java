package app.polaris.tv;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * The people who watch this TV ("Who's watching?"). The TV holds the only copy: prefs {@code profiles} keep the
 * roster as JSON ({@code [{id, name, avatar, position, named, language?}]}), the active profile and which profile
 * the TV's Polaris link belongs to. The list logic is pure so it is tested off the TV; reading and writing the
 * prefs is the Context half below.
 */
final class Profiles {
    static final String PREFS = "profiles";
    static final int MAX = 6;
    static final int NAME_MAX = 20;
    /** The screen has to be off this long before the picker asks again. */
    static final long PICKER_AFTER_OFF_MS = 60L * 60L * 1000L;
    /** Avatar keys: a coloured circle with the profile's initial, see {@link #avatarColor}. */
    static final String[] AVATARS = {"blue", "teal", "green", "lime", "amber", "orange",
            "red", "pink", "purple", "indigo", "slate", "brown"};
    private static final int[] AVATAR_COLORS = {0xFF3B82F6, 0xFF14B8A6, 0xFF22C55E, 0xFF84CC16, 0xFFF59E0B,
            0xFFF97316, 0xFFEF4444, 0xFFEC4899, 0xFFA855F7, 0xFF6366F1, 0xFF64748B, 0xFFA16207};
    private static final String ROSTER = "roster";
    private static final String ACTIVE = "activeId";
    /** The profile the TV's existing single link belongs to; slice 3 moves links per profile and host. */
    private static final String LINKED = "linkedId";
    private static final String LEGACY_RECENTS = "last_opened";

    private Profiles() {
    }

    static final class Profile {
        final String id;
        /** What was typed, or for a migrated profile the name it was given; "" means the translated default. */
        final String name;
        final String avatar;
        /** Named on the TV: the greeting says this name. A migrated profile greets as the TV did before. */
        final boolean named;
        /** A language tag chosen for this profile, "" for none (applied by a later slice). */
        final String language;

        Profile(String id, String name, String avatar, boolean named, String language) {
            this.id = id;
            this.name = name == null ? "" : name;
            this.avatar = validAvatar(avatar) ? avatar : AVATARS[0];
            this.named = named;
            this.language = language == null ? "" : language;
        }

        Profile renamed(String newName) {
            return new Profile(id, cleanName(newName), avatar, true, language);
        }

        Profile withAvatar(String key) {
            return new Profile(id, name, key, named, language);
        }
    }

    // ---- Pure list logic ----

    /** The roster as stored; anything malformed is dropped, duplicates and anything past {@link #MAX} too. */
    static List<Profile> parse(String json) {
        List<Profile> out = new ArrayList<>();
        if (json == null || json.isEmpty()) return out;
        try {
            JSONArray array = new JSONArray(json);
            List<JSONObject> items = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item != null) items.add(item);
            }
            Collections.sort(items, (a, b) -> Integer.compare(a.optInt("position", 0), b.optInt("position", 0)));
            Set<String> seen = new HashSet<>();
            for (JSONObject item : items) {
                String id = item.optString("id", "");
                if (id.isEmpty() || !seen.add(id) || out.size() >= MAX) continue;
                out.add(new Profile(id, cleanName(item.optString("name", "")), item.optString("avatar", ""),
                        item.optBoolean("named", false), item.optString("language", "")));
            }
        } catch (JSONException malformed) {
            out.clear();
        }
        return out;
    }

    static String toJson(List<Profile> roster) {
        JSONArray array = new JSONArray();
        try {
            for (int i = 0; i < roster.size(); i++) {
                Profile p = roster.get(i);
                JSONObject item = new JSONObject().put("id", p.id).put("name", p.name).put("avatar", p.avatar)
                        .put("position", i).put("named", p.named);
                if (!p.language.isEmpty()) item.put("language", p.language);
                array.put(item);
            }
        } catch (JSONException cannotHappen) {
            throw new IllegalStateException(cannotHappen);
        }
        return array.toString();
    }

    /** What a typed name becomes: no control characters, single spaces, at most {@link #NAME_MAX} characters. */
    static String cleanName(String typed) {
        String name = LinkedAccount.firstName(typed, null);
        int end = name.offsetByCodePoints(0, Math.min(NAME_MAX, name.codePointCount(0, name.length())));
        return name.substring(0, end).trim();
    }

    static boolean validAvatar(String key) {
        for (String avatar : AVATARS) if (avatar.equals(key)) return true;
        return false;
    }

    static int avatarColor(String key) {
        for (int i = 0; i < AVATARS.length; i++) if (AVATARS[i].equals(key)) return AVATAR_COLORS[i];
        return AVATAR_COLORS[0];
    }

    /**
     * Profile #1 of a TV that had none: named after the linked account's first name, else the theme's
     * greeting_name, else "" (shown as the translated default). Not "named", so the greeting stays what it was.
     */
    static Profile first(String id, String accountFirstName, String themeGreetingName) {
        String name = cleanName(accountFirstName);
        if (name.isEmpty()) name = cleanName(themeGreetingName);
        return new Profile(id, name, AVATARS[0], false, "");
    }

    static boolean canAdd(List<Profile> roster) {
        return roster.size() < MAX;
    }

    /** The roster with a new profile at the end, or null when it is full or the name is empty. */
    static List<Profile> add(List<Profile> roster, String id, String typedName, String avatar) {
        String name = cleanName(typedName);
        if (!canAdd(roster) || name.isEmpty()) return null;
        List<Profile> out = new ArrayList<>(roster);
        out.add(new Profile(id, name, avatar, true, ""));
        return out;
    }

    /** The roster without that profile, or null when it is the last one (a TV always has one) or unknown. */
    static List<Profile> remove(List<Profile> roster, String id) {
        if (roster.size() <= 1 || indexOf(roster, id) < 0) return null;
        List<Profile> out = new ArrayList<>(roster);
        out.remove(indexOf(roster, id));
        return out;
    }

    static List<Profile> replace(List<Profile> roster, Profile changed) {
        int at = indexOf(roster, changed.id);
        if (at < 0) return roster;
        List<Profile> out = new ArrayList<>(roster);
        out.set(at, changed);
        return out;
    }

    /** The roster with that profile moved by {@code delta} places, kept inside the list. */
    static List<Profile> move(List<Profile> roster, String id, int delta) {
        int from = indexOf(roster, id);
        if (from < 0) return roster;
        int to = Math.max(0, Math.min(roster.size() - 1, from + delta));
        List<Profile> out = new ArrayList<>(roster);
        out.add(to, out.remove(from));
        return out;
    }

    static int indexOf(List<Profile> roster, String id) {
        for (int i = 0; i < roster.size(); i++) if (roster.get(i).id.equals(id)) return i;
        return -1;
    }

    /** The active profile, or the first one when the stored id is gone. Null only for an empty roster. */
    static Profile active(List<Profile> roster, String activeId) {
        int at = activeId == null ? -1 : indexOf(roster, activeId);
        return at >= 0 ? roster.get(at) : roster.isEmpty() ? null : roster.get(0);
    }

    /**
     * Whether "Who's watching?" shows: never with one profile; with several, on a cold start or when the screen
     * was off for at least {@link #PICKER_AFTER_OFF_MS}.
     */
    static boolean pickerNeeded(int profiles, boolean coldStart, long offMs) {
        return profiles >= 2 && (coldStart || offMs >= PICKER_AFTER_OFF_MS);
    }

    /**
     * The name the greeting adds for this profile: its own when it was named on the TV; otherwise what the TV
     * said before profiles (the theme's greeting_name, else the account's first name when the link is this
     * profile's).
     */
    static String greetingName(Profile profile, boolean linkedHere, String themeGreetingName, String accountFirstName) {
        if (profile != null && profile.named && !profile.name.isEmpty()) return profile.name;
        if (themeGreetingName != null && !themeGreetingName.isEmpty()) return themeGreetingName;
        return linkedHere && accountFirstName != null ? accountFirstName : "";
    }

    /**
     * Whether the TV's Polaris link is this profile's. With no roster the link is the TV's; with one, only the
     * recorded profile's, so none is once the profile it belonged to was deleted.
     */
    static boolean linkedHere(Profile profile, String linkedId) {
        return profile == null || profile.id.equals(linkedId);
    }

    // ---- On the TV ----

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static List<Profile> load(Context ctx) {
        return parse(prefs(ctx).getString(ROSTER, null));
    }

    static String activeId(Context ctx) {
        return prefs(ctx).getString(ACTIVE, null);
    }

    static String linkedId(Context ctx) {
        return prefs(ctx).getString(LINKED, null);
    }

    static void save(Context ctx, List<Profile> roster) {
        prefs(ctx).edit().putString(ROSTER, toJson(roster)).commit();
    }

    /** Whose the TV's Polaris link is; null when the profile it belonged to was deleted. */
    static void setLinked(Context ctx, String id) {
        SharedPreferences.Editor edit = prefs(ctx).edit();
        if (id == null) edit.remove(LINKED);
        else edit.putString(LINKED, id);
        edit.commit();
    }

    static void setActive(Context ctx, String id) {
        prefs(ctx).edit().putString(ACTIVE, id).commit();
    }

    /** The prefs file that holds a profile's recents. */
    static String recentsFile(String profileId) {
        return LEGACY_RECENTS + "_" + profileId;
    }

    /**
     * Once, before Home first draws: a TV without a roster gets profile #1, which takes over the existing link
     * (recorded, the link itself stays where it is) and the recents. Safe to run again after an interruption: the
     * roster is the last thing written, and the old recents are cleared only after it.
     */
    static void migrate(Context ctx, String themeGreetingName) {
        if (!load(ctx).isEmpty()) return;
        boolean linked = PolarisLink.connected(ctx);
        Profile one = first(UUID.randomUUID().toString(), linked ? PolarisLink.accountFirstName(ctx) : "",
                themeGreetingName);
        SharedPreferences legacy = ctx.getSharedPreferences(LEGACY_RECENTS, Context.MODE_PRIVATE);
        SharedPreferences.Editor recents = ctx.getSharedPreferences(recentsFile(one.id), Context.MODE_PRIVATE).edit();
        for (Map.Entry<String, ?> entry : legacy.getAll().entrySet()) {
            if (entry.getValue() instanceof Long) recents.putLong(entry.getKey(), (Long) entry.getValue());
        }
        recents.commit();
        SharedPreferences.Editor edit = prefs(ctx).edit().putString(ROSTER, toJson(Collections.singletonList(one)))
                .putString(ACTIVE, one.id);
        if (linked) edit.putString(LINKED, one.id);
        else edit.remove(LINKED);
        edit.commit();
        legacy.edit().clear().commit();
    }
}
