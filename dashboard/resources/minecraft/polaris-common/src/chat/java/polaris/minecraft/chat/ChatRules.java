package polaris.minecraft.chat;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * What the chat is held to on this server, as the Polaris that runs it last said.
 *
 * Polaris owns every number and word here (the server's Moderation tab), and the
 * mod or plugin only applies them: nothing is decided on this side but whether
 * one line breaks one of them. A server that has not heard from Polaris yet holds
 * nobody to anything ({@link #OFF}).
 *
 * Read with the oldest Gson calls there are, so the same class loads on every
 * server it is built into - a 1.8 Spigot included.
 */
public final class ChatRules {
    /** Nothing checked: before Polaris answers, and when it says so. */
    public static final ChatRules OFF = new ChatRules();

    final boolean enabled;
    final boolean flood;
    final int maxPerMinute;
    final int burstLines;
    final long burstMs;
    final boolean repeats;
    final int maxRepeated;
    final long repeatMs;
    final boolean caps;
    final int capsMinLetters;
    final double capsRatio;
    final boolean links;
    final boolean advertising;
    final boolean exemptOperators;
    final Set<String> allowedDomains;
    final Set<String> topLevelDomains;
    final List<String> words;
    final Set<String> commands;
    final Map<String, String> fallback;

    private ChatRules() {
        enabled = false;
        flood = false;
        maxPerMinute = 0;
        burstLines = 0;
        burstMs = 0;
        repeats = false;
        maxRepeated = 0;
        repeatMs = 0;
        caps = false;
        capsMinLetters = 0;
        capsRatio = 1;
        links = false;
        advertising = false;
        exemptOperators = true;
        allowedDomains = Collections.emptySet();
        topLevelDomains = Collections.emptySet();
        words = Collections.emptyList();
        commands = Collections.emptySet();
        fallback = Collections.emptyMap();
    }

    private ChatRules(JsonObject body) {
        enabled = flag(body, "enabled", false);
        flood = flag(body, "flood", false);
        maxPerMinute = Math.max(1, number(body, "maxPerMinute", 30));
        burstLines = Math.max(1, number(body, "burstLines", 5));
        burstMs = Math.max(1_000L, number(body, "burstMs", 5_000));
        repeats = flag(body, "repeats", false);
        maxRepeated = Math.max(1, number(body, "maxRepeated", 3));
        repeatMs = Math.max(1_000L, number(body, "repeatMs", 120_000));
        caps = flag(body, "caps", false);
        capsMinLetters = Math.max(1, number(body, "capsMinLetters", 8));
        capsRatio = Math.min(1, Math.max(0.5, number(body, "capsPercent", 70) / 100.0));
        links = flag(body, "links", false);
        advertising = flag(body, "advertising", false);
        exemptOperators = flag(body, "exemptOperators", true);
        allowedDomains = lowered(texts(body, "allowedDomains"));
        topLevelDomains = lowered(texts(body, "topLevelDomains"));
        List<String> normalized = new ArrayList<>();
        for (String word : texts(body, "words")) {
            String one = ChatText.normalizeWord(word);
            if (!one.isEmpty()) normalized.add(one);
        }
        words = Collections.unmodifiableList(normalized);
        commands = lowered(texts(body, "commands"));
        Map<String, String> said = new HashMap<>();
        JsonElement warnings = body.get("fallback");
        if (warnings != null && warnings.isJsonObject()) {
            for (Map.Entry<String, JsonElement> entry : warnings.getAsJsonObject().entrySet()) {
                if (entry.getValue().isJsonPrimitive()) said.put(entry.getKey(), entry.getValue().getAsString());
            }
        }
        fallback = Collections.unmodifiableMap(said);
    }

    /** The rules in a body Polaris sent. Anything missing or of the wrong type
     *  reads as its default, never as a failure. */
    public static ChatRules parse(JsonObject body) {
        return new ChatRules(body);
    }

    public boolean enabled() {
        return enabled;
    }

    /** Whether operators are left alone: they are the ones keeping order. */
    public boolean exemptOperators() {
        return exemptOperators;
    }

    /** Whether a command (lower case, no slash) carries chat that is held to these
     *  rules - {@code msg}, {@code me} and the like. */
    public boolean moderatesCommand(String command) {
        return commands.contains(command);
    }

    /** What to tell a player when Polaris cannot be asked, in the server's own
     *  language. */
    public String fallback(String reason) {
        String text = fallback.get(reason);
        return text == null ? "" : text;
    }

    private static boolean flag(JsonObject body, String name, boolean otherwise) {
        JsonElement value = body.get(name);
        try {
            return value != null && value.isJsonPrimitive() ? value.getAsBoolean() : otherwise;
        } catch (RuntimeException wrongType) {
            return otherwise;
        }
    }

    private static int number(JsonObject body, String name, int otherwise) {
        JsonElement value = body.get(name);
        try {
            return value != null && value.isJsonPrimitive() ? value.getAsInt() : otherwise;
        } catch (RuntimeException wrongType) {
            return otherwise;
        }
    }

    private static List<String> texts(JsonObject body, String name) {
        List<String> out = new ArrayList<>();
        JsonElement value = body.get(name);
        if (value == null || !value.isJsonArray()) return out;
        JsonArray array = value.getAsJsonArray();
        for (int i = 0; i < array.size() && i < 2_000; i++) {
            JsonElement item = array.get(i);
            if (item.isJsonPrimitive()) out.add(item.getAsString());
        }
        return out;
    }

    private static Set<String> lowered(List<String> values) {
        Set<String> out = new HashSet<>();
        for (String value : values) {
            String one = value.trim().toLowerCase(Locale.ROOT);
            if (!one.isEmpty()) out.add(one);
        }
        return Collections.unmodifiableSet(out);
    }
}
