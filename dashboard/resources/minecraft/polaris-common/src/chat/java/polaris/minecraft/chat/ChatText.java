package polaris.minecraft.chat;

import java.text.Normalizer;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a chat line says once the usual disguises are taken off it: accents,
 * digits standing in for letters, letters held down, "dot" spelled out, spaces
 * around the dots of an address.
 *
 * Pure: the rules' own checks, kept apart so each can be read on its own.
 */
final class ChatText {
    private ChatText() {
    }

    private static final Pattern MARKS = Pattern.compile("\\p{M}+");
    private static final Pattern REPEATS = Pattern.compile("([a-z0-9])\\1+");
    /** "play dot example dot net", "play(.)example[dot]net". A plain dot with
     *  spaces around it is left alone: that is the end of a sentence. */
    private static final Pattern SPELLED_DOT =
            Pattern.compile("\\s*[\\(\\[\\{]\\s*(?:dot|punto|\\.)\\s*[\\)\\]\\}]\\s*|\\s+(?:dot|punto)\\s+");
    private static final Pattern URL = Pattern.compile("(?:https?://|www\\.)[^\\s]+", Pattern.CASE_INSENSITIVE);
    private static final Pattern IPV4 = Pattern.compile(
            "(?<![\\d.])(\\d{1,3})\\s*[.,]\\s*(\\d{1,3})\\s*[.,]\\s*(\\d{1,3})\\s*[.,]\\s*(\\d{1,3})(?!\\d)");
    private static final Pattern HOST = Pattern.compile(
            "(?<![\\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+([a-z]{2,24}))(?![\\w-])");

    /** A word as the blocked-words list compares it. */
    static String normalizeWord(String text) {
        String out = Normalizer.normalize(text.toLowerCase(Locale.ROOT), Normalizer.Form.NFD);
        out = MARKS.matcher(out).replaceAll("");
        StringBuilder mapped = new StringBuilder(out.length());
        for (int i = 0; i < out.length(); i++) {
            char c = out.charAt(i);
            switch (c) {
                case '0' -> mapped.append('o');
                case '1', '!', '|' -> mapped.append('i');
                case '3' -> mapped.append('e');
                case '4', '@' -> mapped.append('a');
                case '5', '$' -> mapped.append('s');
                case '7' -> mapped.append('t');
                default -> mapped.append(c);
            }
        }
        out = REPEATS.matcher(mapped.toString()).replaceAll("$1");
        return out.replaceAll("[^a-z0-9]+", " ").trim();
    }

    /** Whether a line contains a blocked word or phrase, whole. */
    static String blockedWord(String line, Iterable<String> words) {
        String padded = " " + normalizeWord(line) + " ";
        for (String word : words) {
            if (padded.contains(" " + word + " ")) return word;
        }
        return null;
    }

    /** The line as the repeat check compares it: case, spacing and trailing
     *  punctuation do not make a line new. */
    static String sameness(String line) {
        return line.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").replaceAll("[\\s.!?]+$", "").trim();
    }

    /** The first web address in a line, or null. */
    static String link(String line) {
        Matcher found = URL.matcher(line);
        return found.find() ? found.group() : null;
    }

    /**
     * The first other server named in a line - an IPv4 address, or a host name on
     * a known top-level domain that is not one of the allowed ones - or null.
     *
     * A web address with a path is a link, not a server, and is left to the links
     * rule; one with nothing after the host still names a server.
     */
    static String advertised(String line, Set<String> topLevelDomains, Set<String> allowed) {
        String lower = line.toLowerCase(Locale.ROOT);
        StringBuilder withoutLinks = new StringBuilder();
        Matcher url = URL.matcher(lower);
        int last = 0;
        while (url.find()) {
            withoutLinks.append(lower, last, url.start()).append(' ');
            String address = url.group().replaceFirst("^https?://", "");
            int slash = address.indexOf('/');
            String rest = slash < 0 ? "" : address.substring(slash + 1);
            // A bare address, or one ending at the host, still names a server.
            if (rest.isEmpty()) withoutLinks.append(address.replaceAll("/+$", "")).append(' ');
            last = url.end();
        }
        withoutLinks.append(lower.substring(last));
        String text = withoutLinks.toString();

        Matcher ip = IPV4.matcher(text);
        while (ip.find()) {
            boolean octets = true;
            for (int group = 1; group <= 4; group++) {
                if (Integer.parseInt(ip.group(group)) > 255) octets = false;
            }
            String address = ip.group(1) + "." + ip.group(2) + "." + ip.group(3) + "." + ip.group(4);
            if (octets && !isAllowed(address, allowed)) return address;
        }

        String dotted = SPELLED_DOT.matcher(text).replaceAll(".");
        Matcher host = HOST.matcher(dotted);
        while (host.find()) {
            String name = host.group(1);
            if (topLevelDomains.contains(host.group(2)) && !isAllowed(name, allowed)) return name;
        }
        return null;
    }

    private static boolean isAllowed(String host, Set<String> allowed) {
        for (String domain : allowed) {
            if (host.equals(domain) || host.endsWith("." + domain)) return true;
        }
        return false;
    }

    /** Whether a line is shouted: enough letters, and nearly all capitals. */
    static boolean shouted(String line, int minLetters, double ratio) {
        int letters = 0;
        int upper = 0;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (!Character.isLetter(c)) continue;
            letters++;
            if (Character.isUpperCase(c)) upper++;
        }
        return letters >= minLetters && upper >= Math.ceil(letters * ratio);
    }
}
