package app.polaris.mobile;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Whether a saved address belongs to what is asking: a port of `uriMatches` in `packages/core/src/vault-uris.ts`, so
 * the phone offers a login on exactly the sites the dashboard and the extension do.
 *
 * An app is named the way every Bitwarden client names it, `androidapp://<package>`, so a login saved from one of
 * them, or by hand in the dashboard, is offered in the app on this phone too.
 */
public final class VaultUris {
    public static final int MATCH_DOMAIN = 0;
    public static final int MATCH_HOST = 1;
    public static final int MATCH_STARTS_WITH = 2;
    public static final int MATCH_EXACT = 3;
    public static final int MATCH_REGEX = 4;
    public static final int MATCH_NEVER = 5;

    public static final String APP_SCHEME = "androidapp://";

    private static final Set<String> SECOND_LEVEL =
            new HashSet<>(Arrays.asList("co", "com", "net", "org", "gov", "edu", "ac", "mil"));
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(?:\\.\\d{1,3}){3}$");
    private static final Pattern SCHEME = Pattern.compile("^[a-z][a-z0-9+.-]*://");

    private VaultUris() {
    }

    public static String forApp(String packageName) {
        return APP_SCHEME + packageName;
    }

    public static String hostOf(String value) {
        if (value == null) return null;
        String text = value.trim().toLowerCase(Locale.ROOT);
        if (text.isEmpty()) return null;
        String withScheme = SCHEME.matcher(text).find() ? text : "https://" + text;
        try {
            String host = new URI(withScheme).getHost();
            if (host == null || host.isEmpty()) return null;
            return host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        } catch (Exception e) {
            return null;
        }
    }

    public static String baseDomain(String host) {
        String lower = host.toLowerCase(Locale.ROOT);
        if (IPV4.matcher(lower).matches() || lower.contains(":")) return lower;
        String[] labels = Arrays.stream(lower.split("\\.")).filter(label -> !label.isEmpty()).toArray(String[]::new);
        if (labels.length <= 2) return String.join(".", labels);
        int take = SECOND_LEVEL.contains(labels[labels.length - 2]) ? 3 : 2;
        return String.join(".", Arrays.copyOfRange(labels, labels.length - take, labels.length));
    }

    static String withoutWildcard(String value) {
        return value.replaceFirst("^(\\*\\.)+", "").replaceFirst("(?i)^([a-z][a-z0-9+.-]*://)(?:\\*\\.)+", "$1");
    }

    /** Whether one saved address, with its match rule (null for the default), covers the candidate. */
    public static boolean matches(String saved, Integer match, String candidate) {
        int rule = match == null ? MATCH_DOMAIN : match;
        if (rule == MATCH_NEVER || saved == null || candidate == null) return false;
        String savedValue = saved.trim();
        String candidateValue = candidate.trim();
        if (savedValue.isEmpty() || candidateValue.isEmpty()) return false;

        if (rule == MATCH_EXACT) return savedValue.equals(candidateValue);
        if (rule == MATCH_STARTS_WITH) return candidateValue.startsWith(savedValue);
        if (rule == MATCH_REGEX) {
            try {
                return Pattern.compile(savedValue, Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE)
                        .matcher(candidateValue).find();
            } catch (PatternSyntaxException e) {
                // A pattern that will not compile matches nothing, never everything.
                return false;
            }
        }

        // An app has no host: it is its package, said exactly, under every rule but the ones above.
        boolean savedApp = savedValue.toLowerCase(Locale.ROOT).startsWith(APP_SCHEME);
        boolean candidateApp = candidateValue.toLowerCase(Locale.ROOT).startsWith(APP_SCHEME);
        if (savedApp || candidateApp) return savedApp && candidateApp && savedValue.equalsIgnoreCase(candidateValue);

        String savedHost = hostOf(withoutWildcard(savedValue));
        String candidateHost = hostOf(candidateValue);
        if (savedHost == null || candidateHost == null) return false;
        if (rule == MATCH_HOST) return savedHost.equals(candidateHost);
        String base = baseDomain(savedHost);
        return !base.isEmpty() && (candidateHost.equals(base) || candidateHost.endsWith("." + base));
    }

    /** What a login saved from here is named after: the site's own host, or the app's label. */
    public static String displayName(String candidate) {
        if (candidate == null) return "";
        if (candidate.startsWith(APP_SCHEME)) return candidate.substring(APP_SCHEME.length());
        String host = hostOf(candidate);
        return host == null ? candidate : host.startsWith("www.") ? host.substring(4) : host;
    }
}
