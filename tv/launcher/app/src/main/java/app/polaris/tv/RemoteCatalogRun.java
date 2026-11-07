package app.polaris.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.ArrayList;
import java.util.List;

/**
 * {@link RemoteCatalog} on a real TV: the theme and add-ons choices it last acted on and what came of them, kept in a
 * private preferences file, and {@link CatalogInstall} to carry them out. Every call blocks (a theme or an add-on is
 * downloaded), so callers run it off the main thread.
 */
final class RemoteCatalogRun {

    private static final String PREFS = "remote_catalog";
    private static final String THEME_CHOICE = "theme_choice";
    private static final String THEME_REPORT = "theme_report";
    private static final String ADDONS_CHOICE = "addons_choice";
    private static final String ADDONS_REPORT = "addons_report";
    /** The packages Android was asked to install for the latest add-ons choice, comma separated. */
    private static final String ADDONS_ASKED = "addons_asked";

    /** What one {@link #apply} did: whether there is something new to report, and whether Home must restart. */
    static final class Applied {
        static final Applied NOTHING = new Applied(false, false);

        final boolean acted;
        final boolean themeApplied;

        Applied(boolean acted, boolean themeApplied) {
            this.acted = acted;
            this.themeApplied = themeApplied;
        }
    }

    private RemoteCatalogRun() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** {@code path} with what to tell the instance about the theme and add-ons on this poll. */
    static String withReport(Context context, String path) {
        SharedPreferences prefs = prefs(context);
        String addons = RemoteCatalog.currentAddons(prefs.getString(ADDONS_REPORT, null),
                allInstalled(context, prefs.getString(ADDONS_ASKED, "")));
        String themed = RemoteCatalog.withReport(path, "theme", prefs.getString(THEME_REPORT, null),
                prefs.getString(THEME_CHOICE, null));
        return RemoteCatalog.withReport(themed, "addons", addons, prefs.getString(ADDONS_CHOICE, null));
    }

    private static boolean allInstalled(Context context, String packages) {
        if (packages.isEmpty()) return false;
        for (String name : packages.split(",")) {
            if (!CatalogInstall.installed(context, name)) return false;
        }
        return true;
    }

    /**
     * Carries out the theme and add-ons picks from a state answer, each once per choice. A catalog this TV cannot
     * reach right now leaves both for the next poll rather than reporting a failure.
     */
    static synchronized Applied apply(Context context, RemoteCatalog.Pick theme, RemoteCatalog.Pick addons) {
        SharedPreferences prefs = prefs(context);
        boolean themeDue = RemoteCatalog.due(theme, prefs.getString(THEME_CHOICE, null));
        boolean addonsDue = RemoteCatalog.due(addons, prefs.getString(ADDONS_CHOICE, null));
        if (!themeDue && !addonsDue) return Applied.NOTHING;
        List<Catalog.Item> catalog;
        try {
            catalog = Catalog.parse(CatalogInstall.fetchCatalog(context));
        } catch (CatalogInstall.Failed unreachable) {
            return Applied.NOTHING;
        }
        int sdk = Build.VERSION.SDK_INT;
        boolean themeApplied = false;
        SharedPreferences.Editor edit = prefs.edit();
        if (themeDue) {
            Catalog.Item item = RemoteCatalog.find(catalog, Catalog.THEME, theme.ids.get(0));
            RemoteCatalog.Outcome outcome = RemoteCatalog.before(item, sdk, false);
            if (outcome == null) {
                try {
                    CatalogInstall.applyTheme(context, item);
                    outcome = RemoteCatalog.Outcome.DONE;
                    themeApplied = true;
                } catch (CatalogInstall.Failed failed) {
                    outcome = RemoteCatalog.Outcome.FAILED;
                }
            }
            edit.putString(THEME_CHOICE, theme.choice).putString(THEME_REPORT, RemoteCatalog.themeReport(outcome));
        }
        if (addonsDue) {
            List<RemoteCatalog.Outcome> outcomes = new ArrayList<>();
            StringBuilder asked = new StringBuilder();
            for (String id : addons.ids) {
                Catalog.Item item = RemoteCatalog.find(catalog, Catalog.ADDON, id);
                boolean installed = item != null && item.packageName != null
                        && CatalogInstall.installed(context, item.packageName);
                RemoteCatalog.Outcome outcome = RemoteCatalog.before(item, sdk, installed);
                if (outcome == null) {
                    try {
                        // Opens Android's own install confirm; it never installs silently.
                        CatalogInstall.installAddon(context, item);
                        outcome = RemoteCatalog.Outcome.ASKED;
                        if (asked.length() > 0) asked.append(',');
                        asked.append(item.packageName);
                    } catch (CatalogInstall.Failed failed) {
                        outcome = RemoteCatalog.Outcome.FAILED;
                    }
                }
                outcomes.add(outcome);
            }
            edit.putString(ADDONS_CHOICE, addons.choice)
                    .putString(ADDONS_REPORT, RemoteCatalog.addonsReport(outcomes))
                    .putString(ADDONS_ASKED, asked.toString());
        }
        edit.commit();
        return new Applied(true, themeApplied);
    }
}
