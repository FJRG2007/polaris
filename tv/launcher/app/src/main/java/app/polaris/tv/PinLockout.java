package app.polaris.tv;

import java.util.function.LongSupplier;

/**
 * Wrong PINs on this TV, per profile. The first {@link #FREE_TRIES} misses cost nothing; from then on each miss
 * means a wait of {@link #FIRST_WAIT_MS}, doubling with every further miss up to {@link #MAX_WAIT_MS}. The state
 * lives in the PIN record (see {@link PinHash.Record}) so a reboot does not reset it. It runs on the wall clock,
 * since that is the one that survives a reboot; a clock set back by more than {@link #SET_BACK_MS} from the
 * latest time seen counts as locked, and the wait starts again from the new time instead of being skipped.
 * Pure: the clock is passed in.
 */
final class PinLockout {
    static final int FREE_TRIES = 5;
    static final long FIRST_WAIT_MS = 30_000L;
    static final long MAX_WAIT_MS = 60L * 60L * 1000L;
    static final long SET_BACK_MS = 10L * 60L * 1000L;

    static final class State {
        static final State NONE = new State(0, 0L, 0L);

        /** Wrong PINs in a row. */
        final int fails;
        /** Wall-clock time the next try is allowed at, 0 for now. */
        final long lockedUntil;
        /** The latest wall-clock time a try or a check saw. */
        final long lastWall;

        State(int fails, long lockedUntil, long lastWall) {
            this.fails = fails;
            this.lockedUntil = lockedUntil;
            this.lastWall = lastWall;
        }
    }

    private final LongSupplier clock;

    PinLockout(LongSupplier clock) {
        this.clock = clock;
    }

    /** The wait after the {@code fails}-th miss in a row: none before {@link #FREE_TRIES}, then doubling, capped. */
    static long waitFor(int fails) {
        if (fails < FREE_TRIES) return 0L;
        int doublings = fails - FREE_TRIES;
        if (doublings >= 30) return MAX_WAIT_MS;
        return Math.min(MAX_WAIT_MS, FIRST_WAIT_MS << doublings);
    }

    /**
     * The state as of now: unchanged, except that a clock set back while a wait is owed restarts that wait from
     * the new time (so setting the clock back never shortens it). Save it when it differs from {@code s}.
     */
    State observe(State s) {
        long now = clock.getAsLong();
        if (s.fails >= FREE_TRIES && now < s.lastWall - SET_BACK_MS) {
            return new State(s.fails, now + waitFor(s.fails), now);
        }
        return s;
    }

    /** How long until the next try is allowed; 0 when it is allowed now. Pass the {@link #observe}d state. */
    long remainingMs(State s) {
        long now = clock.getAsLong();
        if (s.fails >= FREE_TRIES && now < s.lastWall - SET_BACK_MS) return waitFor(s.fails);
        return Math.max(0L, s.lockedUntil - now);
    }

    State fail(State s) {
        long now = clock.getAsLong();
        int fails = s.fails == Integer.MAX_VALUE ? s.fails : s.fails + 1;
        long wait = waitFor(fails);
        return new State(fails, wait == 0 ? 0L : now + wait, Math.max(s.lastWall, now));
    }

    State success(State s) {
        return new State(0, 0L, Math.max(s.lastWall, clock.getAsLong()));
    }
}
