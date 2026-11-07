package app.polaris.tv;

import org.json.JSONObject;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * "Block ads and trackers" asked for from Polaris (/account/tv, often from the phone that scanned the TV's QR).
 *
 * The instance hands the owner's choice to the TV as {@code desired.blocking} on /api/tv/state; the TV applies it
 * with {@link PrivateDns} and says what happened with {@code ?blocking=} on a later poll. Pure: the parsing, the
 * decision and the words for the report, so every path is a unit test ({@link RemoteBlockingRun} does the rest).
 *
 * The TV acts once per choice, which the instance names with {@code desired.choice} (a new id every time the owner
 * flips the switch, even back to what it was): a change made in the TV's own Settings afterwards is kept until the
 * owner flips the switch in Polaris again, and a failed attempt is reported rather than retried on every poll. The
 * report names the choice it answers ({@code &blockingChoice=}), so one about an earlier choice is never taken for
 * the latest.
 */
final class RemoteBlocking {

    /** The words the instance accepts for {@code ?blocking=} (lib/tv/preferences.ts, TV_BLOCKING_REPORTS). */
    static final String ON = "on";
    static final String OFF = "off";
    static final String FAILED = "failed";
    static final String UNAVAILABLE = "unavailable";
    static final String NO_PERMISSION = "no-permission";
    static final String NO_FILTER = "no-filter";
    static final String LEFT_AS_SET = "left-as-set";

    private static final Pattern UUID = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    enum Step {
        NOTHING,
        TURN_ON,
        TURN_OFF
    }

    private RemoteBlocking() {
    }

    /**
     * {@code desired.blocking} from a state answer. Null when the owner never chose, the instance is older than
     * the question, or the block is malformed: the TV then keeps its own setting.
     */
    static Boolean desiredBlocking(JSONObject answer) {
        JSONObject desired = desired(answer);
        if (desired == null) return null;
        Object blocking = desired.opt("blocking");
        return blocking instanceof Boolean ? (Boolean) blocking : null;
    }

    /** {@code desired.choice} from a state answer: the id of the owner's latest choice, or null. */
    static String desiredChoice(JSONObject answer) {
        JSONObject desired = desired(answer);
        if (desired == null) return null;
        Object choice = desired.opt("choice");
        if (!(choice instanceof String)) return null;
        String id = ((String) choice).toLowerCase(Locale.ROOT);
        return UUID.matcher(id).matches() ? id : null;
    }

    private static JSONObject desired(JSONObject answer) {
        return answer == null ? null : answer.optJSONObject("desired");
    }

    /**
     * What names one choice: its id, or for an instance that sends none the value asked. Null when nothing was
     * asked.
     */
    static String choiceKey(Boolean desired, String choice) {
        if (desired == null) return null;
        return choice != null ? choice : String.valueOf(desired);
    }

    /** What to do for {@code desired}, named {@code key}, given the key this TV last acted on (null: none yet). */
    static Step step(Boolean desired, String key, String actedOn) {
        if (desired == null || key == null || key.equals(actedOn)) return Step.NOTHING;
        return desired ? Step.TURN_ON : Step.TURN_OFF;
    }

    /** The report for what {@link PrivateDns} answered. Null for an answer that changes nothing. */
    static String report(PrivateDns.Result result) {
        if (result == null) return null;
        switch (result) {
            case ON: return ON;
            case OFF: return OFF;
            case REVERTED: return FAILED;
            case UNAVAILABLE: return UNAVAILABLE;
            case NO_PERMISSION: return NO_PERMISSION;
            // The instance's own hostname did not read as one: as good as having no filter to point at.
            case BAD_HOSTNAME: return NO_FILTER;
            case LEFT_AS_SET: return LEFT_AS_SET;
            default: return null;
        }
    }

    /**
     * What the TV says now, from the last report it kept and the hostname the launcher still owns (null: none).
     * Blocking that is on, however it got there, is "on"; one that was on and no longer is was changed in the
     * TV's own Settings (a resolver that stopped answering is kept as "failed" when it is undone).
     */
    static String current(String kept, String ours) {
        if (ours != null) return ON;
        if (ON.equals(kept)) return LEFT_AS_SET;
        return kept;
    }

    /**
     * {@code path} with the report, and the choice it answers when there is one, added to its query; unchanged when
     * there is nothing to say.
     */
    static String withReport(String path, String report, String choice) {
        if (report == null || report.isEmpty()) return path;
        String query = path + (path.indexOf('?') >= 0 ? '&' : '?') + "blocking=" + report;
        return choice != null && UUID.matcher(choice).matches() ? query + "&blockingChoice=" + choice : query;
    }
}
