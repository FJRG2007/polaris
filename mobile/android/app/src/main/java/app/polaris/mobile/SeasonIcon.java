package app.polaris.mobile;

import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;

/**
 * The launcher icon in the season's dress - a Santa hat at Christmas, a witch's hat at Halloween - the way the tab
 * and the desktop app wear it.
 *
 * The page decides the season (the operator's switch and the reader's own opt-out included) and says which through
 * `polarisMobile.setSeasonIcon`; the app only remembers it. Android has no API to change an icon, so each dress is
 * a launcher entry of its own in the manifest (an activity-alias of HomeActivity) and exactly one is enabled. The
 * plain one keeps the name `.MainActivity` the launcher entry always had, so home-screen icons placed before this
 * existed still point at it.
 *
 * Switching entries is done only once the person has left the app, never while it is on screen or in a call:
 * - Some launchers and OEM builds restart the app when its launcher entry changes, even with DONT_KILL_APP.
 * - The entry being switched on is enabled before the old one is disabled, so there is never a moment with no
 *   launcher entry; launchers built on AOSP's Launcher3 then move a home-screen icon to the new entry.
 * - Anything that fails puts the plain entry back.
 */
final class SeasonIcon {
    private static final String PREFS = "season_icon";
    private static final String WANTED = "season";
    private static final String TOLD_AT = "toldAt";
    /** A season nobody has repeated for this long (an older Polaris opened since) falls back to the plain icon. */
    private static final long STALE_MS = 14L * 24 * 60 * 60 * 1000;
    /** Long enough for the screen opened next, if it is one of the app's own, to be on screen. */
    private static final long LEAVING_DELAY_MS = 1500;

    /** The plain launcher entry, enabled by the manifest. */
    static final String PLAIN = ".MainActivity";

    /** The season the page names -> the launcher entry that wears it, each disabled by the manifest. */
    private static final String[][] DRESSED = {
        {"halloween", ".SeasonHalloween"},
        {"winter", ".SeasonWinter"},
        {"newYear", ".SeasonNewYear"},
        {"lunarNewYear", ".SeasonLunarNewYear"}
    };

    private SeasonIcon() {}

    /** The launcher entry for a season the page named: the plain one for none, or for a season this app predates. */
    static String entryFor(String season) {
        if (season != null) {
            for (String[] dressed : DRESSED) if (dressed[0].equals(season)) return dressed[1];
        }
        return PLAIN;
    }

    /** The page's season, kept for the next time the person leaves the app. */
    static void remember(Context context, String season) {
        String known = PLAIN.equals(entryFor(season)) ? "" : season;
        prefs(context).edit().putString(WANTED, known).putLong(TOLD_AT, System.currentTimeMillis()).apply();
    }

    /** The entry that should be on now, from what the page said last and when. */
    static String wanted(String season, long toldAt, long now) {
        if (now - toldAt > STALE_MS || now < toldAt) return PLAIN;
        return entryFor(season);
    }

    /** Called as the app's main screen stops: switches the icon once the person has really left the app. */
    static void applyWhenLeaving(Context context) {
        Context app = context.getApplicationContext();
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                if (onScreenOrInCall(app)) return;
                SharedPreferences prefs = prefs(app);
                apply(app, wanted(prefs.getString(WANTED, ""), prefs.getLong(TOLD_AT, 0), System.currentTimeMillis()));
            } catch (RuntimeException failed) {
                restorePlain(app);
            }
        }, LEAVING_DELAY_MS);
    }

    private static boolean onScreenOrInCall(Context app) {
        ActivityManager.RunningAppProcessInfo state = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(state);
        // Compared one by one: the messages service's foreground notification (125) sits between the two and is
        // not a screen.
        int importance = state.importance;
        if (importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                || importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE) return true;
        AudioManager audio = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) return true;
        int mode = audio.getMode();
        return mode == AudioManager.MODE_IN_COMMUNICATION || mode == AudioManager.MODE_IN_CALL;
    }

    private static void apply(Context app, String entry) {
        PackageManager pm = app.getPackageManager();
        if (isOn(pm, app, entry) && othersOff(pm, app, entry)) return;
        // On first, then the rest off: there is always one way into the app from the launcher.
        set(pm, app, entry, true);
        for (String other : entries()) if (!other.equals(entry)) set(pm, app, other, false);
    }

    /** Every launcher entry back to what the manifest says: the plain icon, nothing else. */
    private static void restorePlain(Context app) {
        try {
            PackageManager pm = app.getPackageManager();
            set(pm, app, PLAIN, true);
            for (String[] dressed : DRESSED) set(pm, app, dressed[1], false);
        } catch (RuntimeException ignored) {
            // The entries are as they were: still one launcher entry, since the plain one is switched on first.
        }
    }

    private static String[] entries() {
        String[] all = new String[DRESSED.length + 1];
        all[0] = PLAIN;
        for (int i = 0; i < DRESSED.length; i++) all[i + 1] = DRESSED[i][1];
        return all;
    }

    private static boolean othersOff(PackageManager pm, Context app, String entry) {
        for (String other : entries()) if (!other.equals(entry) && isOn(pm, app, other)) return false;
        return true;
    }

    private static boolean isOn(PackageManager pm, Context app, String entry) {
        int state = pm.getComponentEnabledSetting(component(app, entry));
        if (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT) return PLAIN.equals(entry);
        return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
    }

    /**
     * The manifest's own state wherever it is the one wanted (the plain entry on, the dressed ones off), so a later
     * version that drops an entry or changes a default is never fighting a setting left behind by this one.
     */
    private static void set(PackageManager pm, Context app, String entry, boolean on) {
        int state;
        if (on == PLAIN.equals(entry)) state = PackageManager.COMPONENT_ENABLED_STATE_DEFAULT;
        else if (on) state = PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
        else state = PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
        ComponentName name = component(app, entry);
        if (pm.getComponentEnabledSetting(name) == state) return;
        pm.setComponentEnabledSetting(name, state, PackageManager.DONT_KILL_APP);
    }

    private static ComponentName component(Context app, String entry) {
        // The manifest's namespace, written out: a class's own name can be rewritten by the release build's shrinker.
        return new ComponentName(app.getPackageName(), "app.polaris.mobile" + entry);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
