package polaris.minecraft.chat;

import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Whether one chat line may reach the other players, under the rules Polaris
 * last sent ({@link ChatRules}).
 *
 * Called on whatever thread the server hands chat to - the game thread on
 * NeoForge, a chat thread on Paper - so everything it keeps is per player and
 * locked per player. It never blocks on the network: the rules are already here,
 * and telling Polaris about a blocked line is {@link ChatLink}'s, afterwards.
 */
public final class ChatGuard {
    /** Why a line was stopped; the same words Polaris keys its log and its
     *  warnings by. */
    public static final String FLOOD = "flood";
    public static final String REPEAT = "repeat";
    public static final String CAPS = "caps";
    public static final String LINK = "link";
    public static final String ADVERTISING = "advertising";
    public static final String WORD = "word";

    /** The most lines remembered per player: more than any window counts. */
    private static final int HISTORY_MAX = 128;
    private static final long MINUTE_MS = 60_000;

    /** A line stopped, why, and what in it did it. */
    public record Verdict(String reason, String detail) {
    }

    private record Line(long at, String same) {
    }

    private volatile ChatRules rules = ChatRules.OFF;
    private final Map<UUID, ArrayDeque<Line>> history = new ConcurrentHashMap<>();

    public ChatRules rules() {
        return rules;
    }

    public void update(ChatRules next) {
        rules = next;
    }

    /** A player who left starts afresh next time. */
    public void forget(UUID player) {
        history.remove(player);
    }

    /**
     * Null when the line may be sent; otherwise why not. Every line a player
     * tries counts towards the flood and repeat limits, stopped or not - a
     * player who keeps trying is still flooding.
     */
    public Verdict check(UUID player, String line, long now) {
        ChatRules current = rules;
        if (!current.enabled || line == null || line.isBlank()) return null;

        int lastMinute = 0;
        int burst = 0;
        int same = 0;
        String sameness = ChatText.sameness(line);
        ArrayDeque<Line> lines = history.computeIfAbsent(player, ignored -> new ArrayDeque<>());
        synchronized (lines) {
            long horizon = Math.max(MINUTE_MS, Math.max(current.burstMs, current.repeatMs));
            while (!lines.isEmpty() && (now - lines.peekFirst().at() > horizon || lines.size() >= HISTORY_MAX)) {
                lines.pollFirst();
            }
            lines.addLast(new Line(now, sameness));
            for (Iterator<Line> each = lines.iterator(); each.hasNext(); ) {
                Line earlier = each.next();
                long age = now - earlier.at();
                if (age <= MINUTE_MS) lastMinute++;
                if (age <= current.burstMs) burst++;
                if (age <= current.repeatMs && earlier.same().equals(sameness)) same++;
            }
        }

        String word = current.words.isEmpty() ? null : ChatText.blockedWord(line, current.words);
        if (word != null) return new Verdict(WORD, word);
        if (current.advertising) {
            String server = ChatText.advertised(line, current.topLevelDomains, current.allowedDomains);
            if (server != null) return new Verdict(ADVERTISING, server);
        }
        if (current.links) {
            String link = ChatText.link(line);
            if (link != null) return new Verdict(LINK, link);
        }
        if (current.caps && ChatText.shouted(line, current.capsMinLetters, current.capsRatio)) {
            return new Verdict(CAPS, "");
        }
        if (current.repeats && same > current.maxRepeated) return new Verdict(REPEAT, "");
        if (current.flood && (lastMinute > current.maxPerMinute || burst > current.burstLines)) {
            return new Verdict(FLOOD, lastMinute > current.maxPerMinute ? "minute" : "burst");
        }
        return null;
    }

    /**
     * The chat inside a command line (no slash), when the command is one of those
     * that carries it and so could be used to get round the rules: the whole rest
     * of {@code /me} and {@code /say}, the rest after the name for {@code /msg}.
     * Null for anything else.
     */
    public String chatInCommand(String command) {
        ChatRules current = rules;
        if (!current.enabled || command == null) return null;
        String line = command.startsWith("/") ? command.substring(1) : command;
        String[] parts = line.trim().split("\\s+", 3);
        if (parts.length == 0 || parts[0].isEmpty()) return null;
        String name = parts[0].toLowerCase(Locale.ROOT);
        int colon = name.indexOf(':');
        if (colon >= 0) name = name.substring(colon + 1);
        if (!current.moderatesCommand(name)) return null;
        boolean addressed = name.equals("msg") || name.equals("tell") || name.equals("w");
        if (addressed) return parts.length >= 3 ? parts[2] : null;
        String rest = line.trim().substring(parts[0].length()).trim();
        return rest.isEmpty() ? null : rest;
    }
}
