package app.polaris.tv;

import java.util.function.LongSupplier;

/**
 * Wrong PINs on this TV, per profile. The first {@link #FREE_TRIES} misses cost nothing; from then on each miss
 * means a wait of {@link #FIRST_WAIT_MS}, doubling with every further miss up to {@link #MAX_WAIT_MS}. The state
 * lives in the PIN record (see {@link PinHash.Record}) so a reboot does not reset it. It runs on the wall clock,
 * since that is the one that survives a reboot; a clock set back by more than {@link #SET_BACK_MS} from the
 * latest time seen counts as locked, and the wait starts again from the new time instead of being skipped. Within
 * one boot the wait is also kept on the time since boot, so a clock set forward does not end it either; only a
 * reboot drops that second clock. Pure: the clocks are passed in.
 */
final class PinLockout {
    static final int FREE_TRIES = 5;
    static final long FIRST_WAIT_MS = 30_000L;
    static final long MAX_WAIT_MS = 60L * 60L * 1000L;
    static final long SET_BACK_MS = 10L * 60L * 1000L;

    static final class State {
        static final State NONE = new State(0, 0L, 0L, NO_BOOT, 0L);

        /** Wrong PINs in a row. */
        final int fails;
        /** Wall-clock time the next try is allowed at, 0 for now. */
        final long lockedUntil;
        /** The latest wall-clock time a try or a check saw. */
        final long lastWall;
        /** The boot {@link #elapsedUntil} counts in, {@link #NO_BOOT} for none. */
        final int boot;
        /** Time since boot the next try is allowed at in {@link #boot}, 0 for no wait kept there. */
        final long elapsedUntil;

        State(int fails, long lockedUntil, long lastWall) {
            this(fails, lockedUntil, lastWall, NO_BOOT, 0L);
        }

        State(int fails, long lockedUntil, long lastWall, int boot, long elapsedUntil) {
            this.fails = fails;
            this.lockedUntil = lockedUntil;
            this.lastWall = lastWall;
            this.boot = boot;
            this.elapsedUntil = elapsedUntil;
        }
    }

    /** No boot count known: only the wall clock is kept. */
    static final int NO_BOOT = -1;

    private final LongSupplier clock;
    private final LongSupplier elapsed;
    private final int boot;

    PinLockout(LongSupplier clock) {
        this(clock, () -> 0L, NO_BOOT);
    }

    /** {@code elapsed} is the time since boot and {@code boot} which boot this is ({@link #NO_BOOT} if unknown). */
    PinLockout(LongSupplier clock, LongSupplier elapsed, int boot) {
        this.clock = clock;
        this.elapsed = elapsed;
        this.boot = boot;
    }

    private boolean sameBoot(State s) {
        return boot != NO_BOOT && s.boot == boot && s.elapsedUntil > 0L;
    }

    private State waiting(int fails, long wait, long wall, long lastWall) {
        if (wait == 0L) return new State(fails, 0L, lastWall, NO_BOOT, 0L);
        return new State(fails, wall + wait, lastWall, boot, boot == NO_BOOT ? 0L : elapsed.getAsLong() + wait);
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
            return waiting(s.fails, waitFor(s.fails), now, now);
        }
        return s;
    }

    /** How long until the next try is allowed; 0 when it is allowed now. Pass the {@link #observe}d state. */
    long remainingMs(State s) {
        long now = clock.getAsLong();
        long kept = sameBoot(s) ? Math.max(0L, s.elapsedUntil - elapsed.getAsLong()) : 0L;
        if (s.fails >= FREE_TRIES && now < s.lastWall - SET_BACK_MS) return Math.max(kept, waitFor(s.fails));
        return Math.max(kept, Math.max(0L, s.lockedUntil - now));
    }

    State fail(State s) {
        long now = clock.getAsLong();
        int fails = s.fails == Integer.MAX_VALUE ? s.fails : s.fails + 1;
        return waiting(fails, waitFor(fails), now, Math.max(s.lastWall, now));
    }

    State success(State s) {
        return new State(0, 0L, Math.max(s.lastWall, clock.getAsLong()), NO_BOOT, 0L);
    }
}
