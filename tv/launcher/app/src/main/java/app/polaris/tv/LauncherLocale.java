package app.polaris.tv;

import android.content.Context;
import android.content.res.Configuration;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * locale: the language the launcher shows itself in, instead of the TV's. A China-market Xiaomi offers Chinese and
 * English only, so a Vietnamese owner saw the launcher in Chinese although it is translated into Vietnamese.
 * Each activity wraps its base context here; an empty or malformed tag leaves the TV's language.
 * A TV linked to Polaris follows its account's language unless a language was picked on the TV ({@link #resolve}).
 */
final class LauncherLocale {
    // Subtags after the language, so "sr-Latn" and "ar-EG-u-nu-latn" (Arabic with Western digits) pass too.
    private static final Pattern TAG = Pattern.compile("[a-z]{2,3}(-[A-Za-z0-9]{1,8})*");

    private LauncherLocale() {
    }

    /** The Locale for a config tag such as "vi", "pt-BR" or "ar-EG-u-nu-latn", or null for "" or anything that is not a plain tag. */
    static Locale parse(String tag) {
        if (tag == null || !TAG.matcher(tag.trim()).matches()) return null;
        return Locale.forLanguageTag(tag.trim());
    }

    /**
     * The language to show: one picked in Launcher settings wins; otherwise ("Same as the TV", or never picked)
     * the linked account's; otherwise the theme's when nothing was picked, or the TV's when "Same as the TV" was.
     *
     * @param chosen  the Launcher settings choice, "" for "Same as the TV", or null when never picked
     * @param account the linked account's language tag, or null/"" when not linked or it has none
     * @param theme   the theme's (config.xml / config.json) tag, "" for the TV's
     */
    static String resolve(String chosen, String account, String theme) {
        if (chosen != null && parse(chosen) != null) return chosen.trim();
        if (parse(account) != null) return account.trim();
        if (chosen != null) return "";
        return theme == null ? "" : theme;
    }

    /** base with the configured language, or base itself when locale is off. */
    static Context wrap(Context base) {
        Locale locale = parse(Config.load(base).locale);
        if (locale == null) {
            // Back to the TV's language: formatters that read the default locale follow it again too, instead of
            // keeping a language picked earlier until the process restarts.
            Locale.setDefault(base.getResources().getConfiguration().getLocales().get(0));
            return base;
        }
        // Formatters that take no Context (the clock's date, the lunar line) follow the default locale.
        Locale.setDefault(locale);
        Configuration c = new Configuration(base.getResources().getConfiguration());
        c.setLocale(locale);
        return base.createConfigurationContext(c);
    }
}
