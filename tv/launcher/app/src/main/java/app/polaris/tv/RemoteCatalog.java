package app.polaris.tv;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A theme and add-ons picked for this TV from Polaris (/account/tv), the way {@link RemoteBlocking} carries Block
 * ads and trackers: the instance hands the pick over as {@code desired.theme} ({@code {id, choice}}) and
 * {@code desired.addons} ({@code {ids, choice}}) on /api/tv/state, the TV acts once per choice id, and says what came
 * of it on a later poll with {@code ?theme=&themeChoice=} and {@code ?addons=&addonsChoice=}
 * (lib/tv/catalog-picks.ts). Pure: parsing, the decision per item and the words for the report, so every path is a
 * unit test ({@link RemoteCatalogRun} does the downloading and installing).
 *
 * Add-ons are only ever added: one left out of a later pick stays installed, and every install goes through
 * Android's own confirm.
 */
final class RemoteCatalog {

    /** The words the instance accepts for {@code ?theme=} (lib/tv/preferences.ts, TV_THEME_REPORTS). */
    static final String APPLIED = "applied";
    /** The words the instance accepts for {@code ?addons=} (TV_ADDONS_REPORTS), beside the shared two below. */
    static final String INSTALLED = "installed";
    static final String ASKED = "asked";
    static final String FAILED = "failed";
    static final String UNAVAILABLE = "unavailable";

    /** The instance keeps at most this many add-ons in one pick (TV_ADDONS_MAX). */
    static final int MAX_ADDONS = 64;

    private static final Pattern ID = Pattern.compile("^[a-z0-9][a-z0-9_-]{0,63}$");
    private static final Pattern UUID = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    /** One pick from Polaris: the catalog ids it names (one for a theme) and the id of that choice. */
    static final class Pick {
        final List<String> ids;
        final String choice;

        Pick(List<String> ids, String choice) {
            this.ids = Collections.unmodifiableList(new ArrayList<>(ids));
            this.choice = choice;
        }
    }

    /** What came of one item of a pick. */
    enum Outcome {
        /** The theme is on, or the add-on is installed (it may have been already). */
        DONE,
        /** Android's install confirm was opened for the add-on. */
        ASKED,
        /** Not in this TV's catalog, or not for this TV's Android. */
        UNAVAILABLE,
        FAILED
    }

    private RemoteCatalog() {
    }

    /**
     * {@code desired.theme} from a state answer. Null when the owner never picked one, the instance is older than the
     * question, or the block is malformed: the TV then keeps the theme it wears.
     */
    static Pick desiredTheme(JSONObject answer) {
        JSONObject theme = block(answer, "theme");
        if (theme == null) return null;
        String choice = choice(theme);
        Object id = theme.opt("id");
        if (choice == null || !(id instanceof String) || !ID.matcher((String) id).matches()) return null;
        return new Pick(Collections.singletonList((String) id), choice);
    }

    /**
     * {@code desired.addons} from a state answer: the ids in the order sent, without duplicates. Null when nothing
     * was picked or the block is malformed (an id that does not read, or more than the instance ever sends).
     */
    static Pick desiredAddons(JSONObject answer) {
        JSONObject addons = block(answer, "addons");
        if (addons == null) return null;
        String choice = choice(addons);
        JSONArray ids = addons.optJSONArray("ids");
        if (choice == null || ids == null || ids.length() > MAX_ADDONS) return null;
        Set<String> seen = new LinkedHashSet<>();
        for (int i = 0; i < ids.length(); i++) {
            Object id = ids.opt(i);
            if (!(id instanceof String) || !ID.matcher((String) id).matches()) return null;
            seen.add((String) id);
        }
        return new Pick(new ArrayList<>(seen), choice);
    }

    private static JSONObject block(JSONObject answer, String name) {
        JSONObject desired = answer == null ? null : answer.optJSONObject("desired");
        return desired == null ? null : desired.optJSONObject(name);
    }

    private static String choice(JSONObject block) {
        Object choice = block.opt("choice");
        if (!(choice instanceof String)) return null;
        String id = ((String) choice).toLowerCase(Locale.ROOT);
        return UUID.matcher(id).matches() ? id : null;
    }

    /** True when {@code pick} is a choice this TV has not acted on yet ({@code actedOn}: the last one it did). */
    static boolean due(Pick pick, String actedOn) {
        return pick != null && !pick.choice.equals(actedOn);
    }

    /** The catalog item of {@code kind} named {@code id}, or null. */
    static Catalog.Item find(List<Catalog.Item> catalog, String kind, String id) {
        if (catalog == null) return null;
        for (Catalog.Item item : catalog) {
            if (item.kind.equals(kind) && item.id.equals(id)) return item;
        }
        return null;
    }

    /**
     * What is already known about one item before anything is downloaded, or null when it has to be applied or
     * installed. {@code installed}: an add-on whose package this TV already has.
     */
    static Outcome before(Catalog.Item item, int sdk, boolean installed) {
        if (item == null || !item.runsOn(sdk)) return Outcome.UNAVAILABLE;
        if (!item.isTheme() && installed) return Outcome.DONE;
        return null;
    }

    /** The {@code ?theme=} word for what came of the theme. */
    static String themeReport(Outcome outcome) {
        if (outcome == null) return null;
        switch (outcome) {
            case DONE: return APPLIED;
            case UNAVAILABLE: return UNAVAILABLE;
            default: return FAILED;
        }
    }

    /**
     * The {@code ?addons=} word for the whole pick: a failure is said first, then an install still waiting on the
     * TV's confirm, then one this TV cannot take; installed only when every one is (an empty pick asks for nothing).
     */
    static String addonsReport(List<Outcome> outcomes) {
        boolean asked = false;
        boolean unavailable = false;
        for (Outcome outcome : outcomes) {
            if (outcome == Outcome.FAILED) return FAILED;
            if (outcome == Outcome.ASKED) asked = true;
            if (outcome == Outcome.UNAVAILABLE) unavailable = true;
        }
        if (asked) return ASKED;
        return unavailable ? UNAVAILABLE : INSTALLED;
    }

    /** What to say now about add-ons: once every one Android asked about is installed, they are installed. */
    static String currentAddons(String kept, boolean askedAllInstalled) {
        return ASKED.equals(kept) && askedAllInstalled ? INSTALLED : kept;
    }

    /**
     * {@code path} with {@code key}'s report and the choice it answers ({@code &<key>Choice=}) added to its query;
     * unchanged when there is nothing to say or no choice to name, since the instance ignores a report without one.
     */
    static String withReport(String path, String key, String report, String choice) {
        if (report == null || report.isEmpty() || choice == null || !UUID.matcher(choice).matches()) return path;
        return path + (path.indexOf('?') >= 0 ? '&' : '?') + key + "=" + report + "&" + key + "Choice=" + choice;
    }
}
