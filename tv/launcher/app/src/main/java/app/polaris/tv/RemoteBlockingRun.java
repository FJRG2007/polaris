package app.polaris.tv;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.IOException;

/**
 * {@link RemoteBlocking} on a real TV: the choice it last acted on and what came of it, kept in a private
 * preferences file, and {@link PrivateDnsSwitch} to carry it out. Every call blocks, so callers run it off the
 * main thread.
 */
final class RemoteBlockingRun {

    private static final String PREFS = "remote_blocking";
    /** "true" or "false": the Polaris choice this TV last acted on. */
    private static final String ACTED = "acted";
    /** What came of it, in the instance's words. */
    private static final String REPORT = "report";

    private RemoteBlockingRun() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** What to tell the instance on the next poll, or null when there is nothing to say. */
    static String report(Context context) {
        return RemoteBlocking.current(prefs(context).getString(REPORT, null), PrivateDnsSwitch.of(context).ours());
    }

    /**
     * Carries out {@code desired} from a state answer, once per choice. Blocks up to
     * {@link PrivateDnsSwitch#CHECK_MS} while the resolver is checked. An instance that cannot be reached for its
     * hostname leaves the choice for the next poll.
     */
    static synchronized void apply(Context context, PolarisLink link, Boolean desired) {
        SharedPreferences prefs = prefs(context);
        String acted = prefs.getString(ACTED, null);
        RemoteBlocking.Step step = RemoteBlocking.step(desired, acted == null ? null : Boolean.valueOf(acted));
        if (step == RemoteBlocking.Step.NOTHING) return;
        String report;
        if (step == RemoteBlocking.Step.TURN_OFF) {
            report = RemoteBlocking.report(PrivateDnsSwitch.turnOff(context));
        } else if (!PrivateDnsSwitch.of(context).available()) {
            report = RemoteBlocking.UNAVAILABLE;
        } else {
            String host;
            try {
                host = link.networkFilterHostname();
            } catch (IOException unreachable) {
                return;
            }
            report = host == null ? RemoteBlocking.NO_FILTER
                    : RemoteBlocking.report(PrivateDnsSwitch.turnOn(context, host));
        }
        prefs.edit().putString(ACTED, String.valueOf(desired)).putString(REPORT, report).commit();
    }

    /** The resolver stopped answering and the TV's own DNS is back: say it failed, not that it was changed. */
    static synchronized void noteReverted(Context context) {
        SharedPreferences prefs = prefs(context);
        if (RemoteBlocking.ON.equals(prefs.getString(REPORT, null))) {
            prefs.edit().putString(REPORT, RemoteBlocking.FAILED).commit();
        }
    }
}
