package app.polaris.mobile;

import android.app.assist.AssistStructure;
import android.text.InputType;
import android.util.Pair;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * What a screen in another app is asking for: which boxes take a username and which a password, what they hold at
 * save time, and who is asking - the app's package, or the site when the app is a browser.
 *
 * A site address is believed only from a known browser. Any app can label its own boxes with a web domain, so an
 * address from anything else would let it ask for the login of a site it is pretending to be; it gets the logins saved
 * for its own package instead. The same reasoning as Bitwarden's and Keyguard's trusted-browser lists.
 */
final class AutofillParse {
    /** Browsers whose page address is believed, and this app's own pages (the dashboard). */
    static final Set<String> BROWSERS = new HashSet<>(Arrays.asList(
            "app.polaris.mobile",
            "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary", "org.chromium.chrome",
            "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "org.mozilla.fennec_aurora",
            "org.mozilla.focus", "org.mozilla.klar", "org.torproject.torbrowser", "io.github.forkmaintainers.iceraven",
            "org.ironfoxoss.ironfox", "us.spotco.fennec_dos",
            "com.brave.browser", "com.brave.browser_beta", "com.brave.browser_nightly",
            "com.microsoft.emmx", "com.microsoft.emmx.beta",
            "com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser.beta",
            "com.opera.browser", "com.opera.browser.beta", "com.opera.mini.native", "com.opera.gx",
            "com.vivaldi.browser", "com.vivaldi.browser.snapshot", "com.duckduckgo.mobile.android",
            "com.kiwibrowser.browser", "com.ecosia.android", "com.yandex.browser", "com.mi.globalbrowser",
            "com.huawei.browser", "app.vanadium.browser", "org.bromite.bromite", "org.cromite.cromite",
            "com.cookiegames.smartcookie", "mark.via.gp", "com.aloha.browser", "com.qwant.liberty"));

    private static final Pattern USERNAME_WORDS =
            Pattern.compile("user|email|e-mail|mail|login|account|usuario|correo|identifier|phone|nick", Pattern.CASE_INSENSITIVE);
    private static final Pattern NOT_USERNAME =
            Pattern.compile("search|buscar|captcha|otp|code|coupon|promo", Pattern.CASE_INSENSITIVE);

    final List<AutofillId> usernames = new ArrayList<>();
    final List<AutofillId> passwords = new ArrayList<>();
    String packageName;
    String webDomain;
    String webScheme;
    String usernameValue;
    String passwordValue;
    /** Whether a username box said so itself (a hint or an email keyboard), rather than being the box before a password. */
    private boolean usernameExplicit;
    private AutofillId lastText;
    private String lastTextValue;

    static AutofillParse of(AssistStructure structure) {
        AutofillParse parse = new AutofillParse();
        parse.packageName = structure.getActivityComponent().getPackageName();
        for (int i = 0; i < structure.getWindowNodeCount(); i++) {
            parse.walk(structure.getWindowNodeAt(i).getRootViewNode());
        }
        return parse;
    }

    /** Something here this app can fill: a password box, or a box that clearly takes a username on its own. */
    boolean fillable() {
        return !passwords.isEmpty() || (usernameExplicit && !usernames.isEmpty());
    }

    AutofillId[] ids() {
        List<AutofillId> all = new ArrayList<>(usernames);
        all.addAll(passwords);
        return all.toArray(new AutofillId[0]);
    }

    /** Who is asking, in the form saved logins are matched against. */
    String candidate() {
        if (webDomain != null && !webDomain.isEmpty() && BROWSERS.contains(packageName)) {
            String scheme = webScheme == null || webScheme.isEmpty() ? "https" : webScheme;
            return scheme + "://" + webDomain;
        }
        return VaultUris.forApp(packageName);
    }

    private void walk(AssistStructure.ViewNode node) {
        if (node == null) return;
        if (node.getWebDomain() != null && webDomain == null) {
            webDomain = node.getWebDomain();
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) webScheme = node.getWebScheme();
        }
        if (node.getVisibility() == View.VISIBLE) classify(node);
        for (int i = 0; i < node.getChildCount(); i++) walk(node.getChildAt(i));
    }

    private void classify(AssistStructure.ViewNode node) {
        AutofillId id = node.getAutofillId();
        if (id == null || node.getAutofillType() != View.AUTOFILL_TYPE_TEXT) return;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            int important = node.getImportantForAutofill();
            if (important == View.IMPORTANT_FOR_AUTOFILL_NO
                    || important == View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS) {
                return;
            }
        }
        String value = textOf(node.getAutofillValue());
        String hints = joined(node.getAutofillHints());
        String html = htmlAttributes(node);
        String type = attribute(node, "type");
        int input = node.getInputType();
        int inputClass = input & InputType.TYPE_MASK_CLASS;
        int variation = input & InputType.TYPE_MASK_VARIATION;

        boolean password = hints.contains("password")
                || "password".equals(type)
                || (inputClass == InputType.TYPE_CLASS_TEXT && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                        || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                        || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD))
                || (inputClass == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        if (password) {
            // A one-time code is a password box to the keyboard and nothing this vault holds.
            if (hints.contains("otp") || hints.contains("sms") || html.contains("one-time-code")) return;
            passwords.add(id);
            if (passwordValue == null && value != null && !value.isEmpty()) passwordValue = value;
            // No username box said so: the text box just before the first password is it, as everywhere else.
            if (usernames.isEmpty() && lastText != null) {
                usernames.add(lastText);
                usernameValue = lastTextValue;
            }
            return;
        }

        if (inputClass != InputType.TYPE_CLASS_TEXT && inputClass != 0 && inputClass != InputType.TYPE_CLASS_PHONE) return;
        String words = hints + " " + html + " " + lower(node.getIdEntry()) + " " + lower(node.getHint());
        boolean explicit = hints.contains("username") || hints.contains("email") || hints.contains("phone")
                || "email".equals(type) || html.contains("autocomplete=username") || html.contains("autocomplete=email")
                || (inputClass == InputType.TYPE_CLASS_TEXT && (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
                        || variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS));
        boolean named = USERNAME_WORDS.matcher(words).find() && !NOT_USERNAME.matcher(words).find();
        if ((explicit || named) && passwords.isEmpty()) {
            if (!usernames.contains(id)) usernames.add(id);
            if (usernameValue == null && value != null && !value.isEmpty()) usernameValue = value;
            usernameExplicit = usernameExplicit || explicit;
        }
        if (!NOT_USERNAME.matcher(words).find()) {
            lastText = id;
            lastTextValue = value;
        }
    }

    private static String textOf(AutofillValue value) {
        return value != null && value.isText() ? value.getTextValue().toString() : null;
    }

    private static String joined(String[] hints) {
        if (hints == null) return "";
        return lower(String.join(" ", hints));
    }

    private static String lower(CharSequence value) {
        return value == null ? "" : value.toString().toLowerCase(Locale.ROOT);
    }

    private static String htmlAttributes(AssistStructure.ViewNode node) {
        ViewStructure.HtmlInfo info = node.getHtmlInfo();
        if (info == null || info.getAttributes() == null) return "";
        StringBuilder out = new StringBuilder();
        for (Pair<String, String> pair : info.getAttributes()) {
            out.append(lower(pair.first)).append('=').append(lower(pair.second)).append(' ');
        }
        return out.toString();
    }

    private static String attribute(AssistStructure.ViewNode node, String name) {
        ViewStructure.HtmlInfo info = node.getHtmlInfo();
        if (info == null || info.getAttributes() == null) return "";
        for (Pair<String, String> pair : info.getAttributes()) {
            if (name.equalsIgnoreCase(pair.first)) return lower(pair.second);
        }
        return "";
    }
}
