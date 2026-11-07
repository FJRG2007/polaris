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
    /** What names the Polaris choice this TV last acted on ({@link RemoteBlocking#choiceKey}). */
    private static final String ACTED = "acted";
    /** That choice's id, named in the report; absent for an instance that sends none. */
    private static final String CHOICE = "choice";
    /** What came of it, in the instance's words. */
    private static final String REPORT = "report";

    private RemoteBlockingRun() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** {@code path} with what to tell the instance on this poll, and the choice it answers. */
    static String withReport(Context context, String path) {
        SharedPreferences prefs = prefs(context);
        String report = RemoteBlocking.current(prefs.getString(REPORT, null), PrivateDnsSwitch.of(context).ours());
        return RemoteBlocking.withReport(path, report, prefs.getString(CHOICE, null));
    }

    /**
     * Carries out {@code desired} from a state answer, once per choice. Blocks up to
     * {@link PrivateDnsSwitch#CHECK_MS} while the resolver is checked. An instance that cannot be reached for its
     * hostname leaves the choice for the next poll. True when it acted, so there is an outcome to report.
     */
    static synchronized boolean apply(Context context, PolarisLink link, Boolean desired, String choice) {
        SharedPreferences prefs = prefs(context);
        String key = RemoteBlocking.choiceKey(desired, choice);
        RemoteBlocking.Step step = RemoteBlocking.step(desired, key, prefs.getString(ACTED, null));
        if (step == RemoteBlocking.Step.NOTHING) return false;
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
                return false;
            }
            report = host == null ? RemoteBlocking.NO_FILTER
                    : RemoteBlocking.report(PrivateDnsSwitch.turnOn(context, host));
        }
        prefs.edit().putString(ACTED, key).putString(CHOICE, choice).putString(REPORT, report).commit();
        return true;
    }

    /** The resolver stopped answering and the TV's own DNS is back: say it failed, not that it was changed. */
    static synchronized void noteReverted(Context context) {
        SharedPreferences prefs = prefs(context);
        if (RemoteBlocking.ON.equals(prefs.getString(REPORT, null))) {
            prefs.edit().putString(REPORT, RemoteBlocking.FAILED).commit();
        }
    }
}
