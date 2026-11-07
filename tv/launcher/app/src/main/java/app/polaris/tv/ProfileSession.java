package app.polaris.tv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;

/**
 * Who is watching right now, for the whole process: the active profile, whether "Who's watching?" is still owed
 * for this cold start, and how long the screen was off. Main thread, apart from {@link #activeId} reads.
 */
final class ProfileSession {
    private static volatile String active;
    /** The cold start's question has not been answered (or was not needed) yet. */
    private static boolean coldStartPending = true;
    /** The screen came back after at least {@link Profiles#PICKER_AFTER_OFF_MS} off. */
    private static boolean afterLongOff;
    private static long screenOffAt;

    private ProfileSession() {
    }

    /** The active profile's id, or null before {@link Profiles#migrate} gave the TV one. */
    static String activeId(Context ctx) {
        String id = active;
        if (id == null) {
            Profiles.Profile profile = Profiles.active(Profiles.load(ctx), Profiles.activeId(ctx));
            id = profile == null ? null : profile.id;
            active = id;
        }
        return id;
    }

    static Profiles.Profile active(Context ctx) {
        return Profiles.active(Profiles.load(ctx), activeId(ctx));
    }

    /** Somebody picked a profile: it is the active one from now on, and the picker is answered. */
    static void choose(Context ctx, String id) {
        Profiles.setActive(ctx, id);
        active = id;
        coldStartPending = false;
        afterLongOff = false;
    }

    /** The roster changed (a profile deleted or added): read the active one again. */
    static void reload() {
        active = null;
    }

    static void screenOff(long elapsedNow) {
        screenOffAt = elapsedNow;
    }

    static void screenOn(long elapsedNow) {
        if (screenOffAt != 0 && elapsedNow - screenOffAt >= Profiles.PICKER_AFTER_OFF_MS) afterLongOff = true;
        screenOffAt = 0;
    }

    /**
     * Whether Home has to ask "Who's watching?" now. With one profile the cold start's question is settled for
     * good, so a second profile added later does not make the picker appear until the next cold start. A single
     * profile with a PIN ({@code pinned}, the active one) still asks, since the PIN is asked there.
     */
    static boolean pickerDue(int profiles, boolean pinned) {
        int count = pinned ? Math.max(2, profiles) : profiles;
        boolean due = Profiles.pickerNeeded(count, coldStartPending, afterLongOff ? Long.MAX_VALUE : 0L);
        if (count < 2) {
            coldStartPending = false;
            afterLongOff = false;
        }
        return due;
    }

    /**
     * The active profile has a PIN and nobody has typed it (or picked another profile) since the cold start or
     * the last long screen-off: only "Who's watching?" may show until then.
     */
    static boolean locked(Context ctx) {
        if (!coldStartPending && !afterLongOff) return false;
        String id = activeId(ctx);
        return id != null && Profiles.hasPin(ctx, id);
    }

    /**
     * For the screens past Home (Polaris, Launcher settings, Quick settings) in onResume: while locked, the viewer
     * goes back to Home, which asks "Who's watching?". True when it did, and the screen is finishing.
     */
    static boolean sendHomeIfLocked(Activity activity) {
        if (!locked(activity)) return false;
        activity.startActivity(new Intent(activity, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        activity.finish();
        return true;
    }
}
