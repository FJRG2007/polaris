package app.polaris.tv;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * "Block ads and trackers": Android's Private DNS pointed at a filtering resolver, with the TV's own setting
 * saved first and put back whenever the new one is not proved to work.
 *
 * Pure: the system settings, the launcher's own record and the check are handed in, so every path is a unit
 * test. The two keys are AOSP's (ConnectivitySettingsManager, Settings.Global) and exist from Android 9.
 * Writing them needs WRITE_SECURE_SETTINGS, which only an install over ADB can grant.
 *
 * A TV is never left on a resolver that did not answer: {@link #turnOn} puts the saved values back when the
 * check fails, and {@link #watch} does the same when names stop resolving later.
 */
final class PrivateDns {

    static final int MIN_SDK = 28;
    static final String MODE = "private_dns_mode";
    static final String SPECIFIER = "private_dns_specifier";
    static final String MODE_HOSTNAME = "hostname";

    /** The launcher's record: what the TV had before, and the hostname this switch set. */
    static final String SAVED_MODE = "dns_prior_mode";
    static final String SAVED_SPECIFIER = "dns_prior_specifier";
    static final String SAVED_OURS = "dns_ours";
    /** Settings.Global answers null for a key never written; the record keeps that apart from "". */
    static final String UNSET = "(unset)";

    private static final Pattern LABEL = Pattern.compile("[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?");

    /** A key-value view: Settings.Global for the system, SharedPreferences for the record. */
    interface Store {
        String get(String key);

        /** False when the write was refused. A null value removes the key. */
        boolean put(String key, String value);
    }

    /** Proves names resolve through {@code hostname}. Blocks, up to its own time limit. */
    interface Check {
        boolean works(String hostname);
    }

    enum Result {
        /** Android 8: there is no Private DNS. */
        UNAVAILABLE,
        /** The install did not grant WRITE_SECURE_SETTINGS. */
        NO_PERMISSION,
        BAD_HOSTNAME,
        /** On, and names resolve through it. */
        ON,
        /** It did not work, and the TV's own setting is back. */
        REVERTED,
        /** Off: the TV's own setting is back, or was never changed. */
        OFF,
        /** Off for the launcher, but the TV's Settings were changed since, so they were left alone. */
        LEFT_AS_SET,
        /** Nothing to do. */
        UNCHANGED
    }

    private final int sdk;
    private final boolean permitted;
    private final Store system;
    private final Store record;
    private final Check check;

    PrivateDns(int sdk, boolean permitted, Store system, Store record, Check check) {
        this.sdk = sdk;
        this.permitted = permitted;
        this.system = system;
        this.record = record;
        this.check = check;
    }

    boolean available() {
        return sdk >= MIN_SDK;
    }

    /** The hostname this switch set and still owns, or null. */
    String ours() {
        String host = record.get(SAVED_OURS);
        if (host == null || host.isEmpty()) return null;
        return MODE_HOSTNAME.equals(system.get(MODE)) && host.equals(system.get(SPECIFIER)) ? host : null;
    }

    /** Lower case, trimmed, and a DNS name with at least one dot (an IP is not a Private DNS hostname). */
    static String normalize(String typed) {
        if (typed == null) return null;
        String host = typed.trim().toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.isEmpty() || host.length() > 253 || !host.contains(".")) return null;
        String[] labels = host.split("\\.", -1);
        for (String label : labels) if (!LABEL.matcher(label).matches()) return null;
        // An address typed instead of a name: the last label of a real name is never all digits.
        if (labels[labels.length - 1].matches("[0-9]+")) return null;
        return host;
    }

    /** Saves the TV's setting (once), points it at {@code typed}, and keeps it only if the check passes. */
    Result turnOn(String typed) {
        if (!available()) return Result.UNAVAILABLE;
        if (!permitted) return Result.NO_PERMISSION;
        String host = normalize(typed);
        if (host == null) return Result.BAD_HOSTNAME;
        // Switching from one hostname to another keeps the setting from before the first; a record the TV's
        // Settings have overridden since is stale, and what is set now is what Off goes back to.
        if (record.get(SAVED_OURS) != null && ours() == null) forget();
        if (record.get(SAVED_OURS) == null) {
            if (!record.put(SAVED_MODE, orUnset(system.get(MODE)))
                    || !record.put(SAVED_SPECIFIER, orUnset(system.get(SPECIFIER)))) {
                return Result.NO_PERMISSION;
            }
        }
        // Recorded before the write, so a launcher stopped during the check still owns it and {@link #watch}
        // can put it back.
        if (!record.put(SAVED_OURS, host)) return Result.NO_PERMISSION;
        // The specifier first, so hostname mode never points at whatever was there before.
        boolean written = system.put(SPECIFIER, host) && system.put(MODE, MODE_HOSTNAME);
        if (!written || !check.works(host)) {
            restore();
            return Result.REVERTED;
        }
        return Result.ON;
    }

    /** Puts the TV's own setting back, unless somebody changed it in the TV's Settings since. */
    Result turnOff() {
        if (record.get(SAVED_OURS) == null) return Result.OFF;
        if (ours() == null) {
            forget();
            return Result.LEFT_AS_SET;
        }
        restore();
        return Result.OFF;
    }

    /**
     * Called when the network changes or Home comes back: our hostname is set and names no longer resolve
     * through it, so the TV goes back to what it had. {@code resolving} is the system's own word for it.
     */
    Result watch(boolean resolving) {
        if (resolving || ours() == null) return Result.UNCHANGED;
        restore();
        return Result.REVERTED;
    }

    private void restore() {
        // Nothing recorded means nothing of ours to undo: never write "unset" over a setting we did not save.
        if (record.get(SAVED_OURS) == null) return;
        // The mode first: hostname mode is never left pointing at the old specifier, nor at a missing one.
        system.put(MODE, fromUnset(record.get(SAVED_MODE)));
        system.put(SPECIFIER, fromUnset(record.get(SAVED_SPECIFIER)));
        forget();
    }

    private void forget() {
        record.put(SAVED_MODE, null);
        record.put(SAVED_SPECIFIER, null);
        record.put(SAVED_OURS, null);
    }

    private static String orUnset(String value) {
        return value == null ? UNSET : value;
    }

    private static String fromUnset(String value) {
        return value == null || UNSET.equals(value) ? null : value;
    }
}
