package app.polaris.mobile;

import android.content.Context;
import android.content.SharedPreferences;

/** The one Polaris this phone opens, kept between launches. */
final class ServerStore {
    private static final String FILE = "server";
    private static final String ORIGIN = "origin";

    private ServerStore() {
    }

    static String origin(Context context) {
        return prefs(context).getString(ORIGIN, null);
    }

    static void save(Context context, String origin) {
        prefs(context).edit().putString(ORIGIN, origin).apply();
    }

    static void forget(Context context) {
        prefs(context).edit().remove(ORIGIN).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
}
