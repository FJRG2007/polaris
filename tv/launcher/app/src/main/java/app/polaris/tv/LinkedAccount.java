package app.polaris.tv;

/**
 * What a linked Polaris says about the TV's owner, made safe to show and to keep: the first name the home greeting
 * adds ("Good afternoon, Sam") and the account's language tag. Pure, so the reading is tested off the TV; storing it
 * is {@link PolarisLink}'s.
 */
final class LinkedAccount {
    /** Longest name the greeting carries; the instance caps it too, an older one does not. */
    static final int NAME_MAX = 40;

    private LinkedAccount() {
    }

    /**
     * The name to greet with, from the instance's firstName, or failing that the first word of its full name (an
     * instance older than firstName). "" when neither holds a name. JSON null arrives as the text "null" from
     * Android's optString, so the caller passes null for it instead.
     */
    static String firstName(String firstName, String fullName) {
        String first = clean(firstName);
        if (first.isEmpty()) {
            String full = clean(fullName);
            int space = full.indexOf(' ');
            first = space < 0 ? full : full.substring(0, space);
        }
        int end = first.offsetByCodePoints(0, Math.min(NAME_MAX, first.codePointCount(0, first.length())));
        return first.substring(0, end);
    }

    /** The account's language as a tag the launcher can show itself in, or "" for none or anything malformed. */
    static String locale(String tag) {
        return LauncherLocale.parse(tag) == null ? "" : tag.trim();
    }

    /** Control and format characters become spaces, runs of space one, and the ends go. */
    private static String clean(String value) {
        if (value == null) return "";
        StringBuilder out = new StringBuilder(value.length());
        value.codePoints().forEach(c -> {
            int type = Character.getType(c);
            boolean hidden = type == Character.CONTROL || type == Character.FORMAT;
            out.appendCodePoint(hidden || Character.isWhitespace(c) ? ' ' : c);
        });
        return out.toString().trim().replaceAll(" {2,}", " ");
    }
}
