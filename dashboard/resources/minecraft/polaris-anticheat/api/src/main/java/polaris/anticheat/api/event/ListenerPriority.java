package polaris.anticheat.api.event;

/**
 * Named priorities for Polaris event listeners.
 *
 * <p>Listeners run in ascending priority order. Registrations that omit a
 * priority use {@link #NORMAL}. {@link #MONITOR} runs last and is intended for
 * listeners that only observe the completed event state. Priorities above
 * {@code MONITOR} are normalized to {@link #HIGHEST}, so they run before
 * monitor listeners.
 *
 * <p>Listeners at the same priority run in registration order. Custom integer
 * priorities at or below {@code MONITOR} retain their exact ordering.
 */
public final class ListenerPriority {
    /** Runs before all other named priorities. */
    public static final int LOWEST = 1_000_000;
    /** Runs after {@link #LOWEST} and before {@link #NORMAL}. */
    public static final int LOW = 2_000_000;
    /** Default listener priority. */
    public static final int NORMAL = 3_000_000;
    /** Runs after {@link #NORMAL} and before {@link #HIGHEST}. */
    public static final int HIGH = 4_000_000;
    /** Highest priority for listeners that may modify event state. */
    public static final int HIGHEST = 5_000_000;
    /** Runs last and should only observe the completed event state. */
    public static final int MONITOR = 6_000_000;

    private ListenerPriority() {
    }

    static int normalize(int priority) {
        return priority > MONITOR ? HIGHEST : priority;
    }
}
