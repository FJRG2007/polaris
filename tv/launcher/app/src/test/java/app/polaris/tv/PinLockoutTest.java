package app.polaris.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PinLockoutTest {
    private static final long T0 = 1_700_000_000_000L;
    private long now = T0;
    private final PinLockout lockout = new PinLockout(() -> now);

    private PinLockout.State failTimes(PinLockout.State s, int times) {
        for (int i = 0; i < times; i++) s = lockout.fail(s);
        return s;
    }

    @Test
    public void fourMissesCostNothingAndTheFifthWaitsThirtySeconds() {
        PinLockout.State s = failTimes(PinLockout.State.NONE, 4);
        assertEquals(0L, lockout.remainingMs(s));
        s = lockout.fail(s);
        assertEquals(30_000L, lockout.remainingMs(s));
        now += 30_000L;
        assertEquals(0L, lockout.remainingMs(s));
    }

    @Test
    public void eachFurtherMissDoublesTheWait() {
        assertEquals(30_000L, PinLockout.waitFor(5));
        assertEquals(60_000L, PinLockout.waitFor(6));
        assertEquals(120_000L, PinLockout.waitFor(7));
        PinLockout.State s = failTimes(PinLockout.State.NONE, 7);
        assertEquals(120_000L, lockout.remainingMs(s));
    }

    @Test
    public void theWaitStopsAtAnHour() {
        assertEquals(PinLockout.MAX_WAIT_MS, PinLockout.waitFor(12));
        assertEquals(PinLockout.MAX_WAIT_MS, PinLockout.waitFor(40));
        assertEquals(PinLockout.MAX_WAIT_MS, PinLockout.waitFor(Integer.MAX_VALUE));
        PinLockout.State s = failTimes(PinLockout.State.NONE, 50);
        assertEquals(PinLockout.MAX_WAIT_MS, lockout.remainingMs(s));
    }

    @Test
    public void theRightPinClearsTheCount() {
        PinLockout.State s = lockout.success(failTimes(PinLockout.State.NONE, 6));
        assertEquals(0, s.fails);
        assertEquals(0L, lockout.remainingMs(s));
        assertEquals(T0, s.lastWall);
    }

    @Test
    public void theWaitSurvivesARestart() throws Exception {
        PinLockout.State s = failTimes(PinLockout.State.NONE, 6);
        PinHash.Record record = PinHash.create("1234", 100_000, new byte[16], derived -> derived).withLockout(s);
        PinHash.Record back = PinHash.decode(PinHash.encode(record));
        assertNotNull(back);
        now += 10_000L;
        PinLockout afterBoot = new PinLockout(() -> now);
        PinLockout.State restored = afterBoot.observe(back.lockout);
        assertEquals(6, restored.fails);
        assertEquals(50_000L, afterBoot.remainingMs(restored));
    }

    @Test
    public void aClockSetBackDoesNotSkipTheWait() {
        now = T0 + 60L * 60L * 1000L;
        PinLockout.State s = failTimes(PinLockout.State.NONE, 6);   // a minute owed
        now = T0;   // an hour back: lockedUntil looks far off, but more importantly it is before lastWall
        assertTrue(lockout.remainingMs(s) > 0);
        PinLockout.State observed = lockout.observe(s);
        assertEquals(60_000L, lockout.remainingMs(observed));
        assertEquals(T0, observed.lastWall);
        now = T0 + 60_000L;
        assertEquals(0L, lockout.remainingMs(lockout.observe(observed)));
    }

    @Test
    public void aSmallClockCorrectionIsNotASetBack() {
        PinLockout.State s = failTimes(PinLockout.State.NONE, 5);
        now = T0 + 31_000L;
        PinLockout.State later = lockout.observe(s);
        now = T0 + 31_000L - 5L * 60L * 1000L;   // five minutes back, inside the ten-minute allowance
        assertSame(s, lockout.observe(later));
    }

    @Test
    public void aSetBackWithNoWaitOwedChangesNothing() {
        now = T0 + 60L * 60L * 1000L;
        PinLockout.State s = failTimes(PinLockout.State.NONE, 2);
        now = T0;
        assertSame(s, lockout.observe(s));
        assertEquals(0L, lockout.remainingMs(s));
    }
}
