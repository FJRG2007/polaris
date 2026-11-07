package app.polaris.tv;

import org.json.JSONObject;

/**
 * "Block ads and trackers" asked for from Polaris (/account/tv, often from the phone that scanned the TV's QR).
 *
 * The instance hands the owner's choice to the TV as {@code desired.blocking} on /api/tv/state; the TV applies it
 * with {@link PrivateDns} and says what happened with {@code ?blocking=} on a later poll. Pure: the parsing, the
 * decision and the words for the report, so every path is a unit test ({@link RemoteBlockingRun} does the rest).
 *
 * The TV acts once per choice: a change made in the TV's own Settings afterwards is kept until the owner flips the
 * switch in Polaris again, and a failed attempt is reported rather than retried on every poll.
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
        if (answer == null) return null;
        JSONObject desired = answer.optJSONObject("desired");
        if (desired == null) return null;
        Object blocking = desired.opt("blocking");
        return blocking instanceof Boolean ? (Boolean) blocking : null;
    }

    /** What to do for {@code desired}, given the choice this TV last acted on (null: none yet). */
    static Step step(Boolean desired, Boolean actedOn) {
        if (desired == null || desired.equals(actedOn)) return Step.NOTHING;
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

    /** {@code path} with the report added to its query; unchanged when there is nothing to say. */
    static String withReport(String path, String report) {
        if (report == null || report.isEmpty()) return path;
        return path + (path.indexOf('?') >= 0 ? '&' : '?') + "blocking=" + report;
    }
}
