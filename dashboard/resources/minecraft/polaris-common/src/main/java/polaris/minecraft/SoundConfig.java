package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * What Polaris tells the server about its own sounds
 * ({@code GET /api/minecraft/sounds/<id>}): the resource pack to hand players,
 * the sounds this jar plays on its own when somebody arrives, and the ones it
 * plays on everyday moments of play ({@code moments}) to whoever the owner picked.
 *
 * Read strictly, in the mod and the plugin alike. A sound becomes part of a
 * command, so only a namespaced id of the shape Polaris writes is kept, and
 * volume and pitch are clamped to what the game accepts; anything else in the
 * reply is dropped rather than trusted.
 */
record SoundConfig(Pack pack, Sound join, Sound welcome, Map<String, Sound> players, Map<String, Cue> moments) {
    /** The scoreboard tag a player carries once their game has loaded the pack:
     *  the dashboard plays the server's sounds to these players only. */
    static final String LOADED_TAG = "polaris_sounds";
    /** Kept in the player's file: they have been here before. */
    static final String SEEN_TAG = "polaris_seen";

    static final SoundConfig NONE = new SoundConfig(null, null, null, Map.of(), Map.of());

    /** The everyday moments this jar knows how to hear. One Polaris names that is
     *  not here (a newer moment) is ignored. */
    static final Set<String> PLAY_MOMENTS =
            Set.of("death", "kill", "leave", "advancement", "nightfall", "daybreak", "dragon", "wither");
    /** How far "near" reaches, in blocks; the same as the dashboard's {@code NEAR_BLOCKS}. */
    static final int NEAR_BLOCKS = 48;

    /** Who hears an everyday moment: the player it happened to, the players near
     *  where it did, or everybody on. Only ever players carrying {@link #LOADED_TAG}. */
    enum Audience { PLAYER, NEAR, ALL }

    record Cue(Sound sound, Audience audience) {}

    private static final Pattern SOUND = Pattern.compile("^polaris:[a-z0-9_]{1,40}$");
    private static final Pattern SHA1 = Pattern.compile("^[0-9a-f]{40}$");
    private static final Pattern PLAYER = Pattern.compile("^[a-z0-9_]{1,16}$");
    private static final int MAX_PROMPT = 160;
    private static final int MAX_URL = 1024;
    private static final int MAX_PLAYERS = 200;

    /** {@code kick} is the line a player who turns down a required pack is
     *  disconnected with, in the owner's language; empty where Polaris sent none. */
    record Pack(UUID id, String url, String sha1, boolean required, Optional<String> prompt, String kick) {}

    record Sound(String id, double volume, double pitch) {
        /** The command that plays it to everybody the selector names, where they stand. */
        String command(String selector) {
            return "execute as " + selector + " at @s run playsound " + id + " master @s ~ ~ ~ "
                    + number(volume) + " " + number(pitch);
        }

        /** The same, to the players with the pack within {@link #NEAR_BLOCKS} of a
         *  point in one dimension. */
        String commandNear(String dimension, double x, double y, double z) {
            return "execute in " + dimension + " positioned " + number(x) + " " + number(y) + " " + number(z)
                    + " as @a[tag=" + LOADED_TAG + ",distance=.." + NEAR_BLOCKS + "] at @s run playsound "
                    + id + " master @s ~ ~ ~ " + number(volume) + " " + number(pitch);
        }

        private static String number(double value) {
            return String.format(Locale.ROOT, "%.3f", value).replaceAll("\\.?0+$", "");
        }
    }

    /**
     * Whether a player holding {@code before} has to be sent {@code after}. Every
     * pack the game is handed reloads its resources, so one it already has is
     * never sent again.
     */
    static boolean differs(Pack before, Pack after) {
        if (before == null || after == null) return before != after;
        return !before.sha1().equals(after.sha1()) || before.required() != after.required()
                || !before.prompt().equals(after.prompt());
    }

    /** A player's answer to a pack, as {@code polaris sounds status} reports it,
     *  from the game's own name for it (the same in every API that passes it on). */
    static String state(String answer) {
        return switch (answer) {
            case "SUCCESSFULLY_LOADED" -> "loaded";
            case "DECLINED" -> "declined";
            case "FAILED_DOWNLOAD", "INVALID_URL", "FAILED_RELOAD", "DISCARDED" -> "failed";
            default -> "pending";
        };
    }

    /** The sound on an everyday moment, and who hears it; null where it has none. */
    Cue cue(String moment) {
        return moments.get(moment);
    }

    /** The sound a player arrives to: their own, or everybody's. */
    Sound arrival(String player) {
        Sound own = players.get(player.toLowerCase(Locale.ROOT));
        return own != null ? own : join;
    }

    static SoundConfig parse(JsonObject body) {
        if (!flag(body, "ok")) return null;
        Map<String, Sound> players = new HashMap<>();
        JsonElement list = body.get("players");
        if (list != null && list.isJsonArray()) {
            JsonArray array = list.getAsJsonArray();
            for (int at = 0; at < array.size() && players.size() < MAX_PLAYERS; at++) {
                if (!array.get(at).isJsonObject()) continue;
                JsonObject one = array.get(at).getAsJsonObject();
                String name = text(one, "player").toLowerCase(Locale.ROOT);
                Sound sound = sound(one);
                if (PLAYER.matcher(name).matches() && sound != null) players.put(name, sound);
            }
        }
        Map<String, Cue> moments = new HashMap<>();
        JsonElement cues = body.get("moments");
        if (cues != null && cues.isJsonObject()) {
            for (String moment : PLAY_MOMENTS) {
                JsonElement one = cues.getAsJsonObject().get(moment);
                if (one == null || !one.isJsonObject()) continue;
                Sound sound = sound(one.getAsJsonObject());
                if (sound != null) moments.put(moment, new Cue(sound, audience(text(one.getAsJsonObject(), "audience"))));
            }
        }
        return new SoundConfig(pack(body.get("pack")), soundAt(body, "join"), soundAt(body, "welcome"), Map.copyOf(players),
                Map.copyOf(moments));
    }

    /** An audience by the dashboard's name for it; one this jar does not know is everybody. */
    private static Audience audience(String name) {
        return switch (name) {
            case "player" -> Audience.PLAYER;
            case "near" -> Audience.NEAR;
            default -> Audience.ALL;
        };
    }

    private static Pack pack(JsonElement element) {
        if (element == null || !element.isJsonObject()) return null;
        JsonObject pack = element.getAsJsonObject();
        String url = text(pack, "url");
        String sha1 = text(pack, "sha1");
        if (url.length() > MAX_URL || !(url.startsWith("https://") || url.startsWith("http://"))) return null;
        if (!SHA1.matcher(sha1).matches()) return null;
        UUID id;
        try {
            id = UUID.fromString(text(pack, "id"));
        } catch (IllegalArgumentException invalid) {
            return null;
        }
        String prompt = line(pack, "prompt");
        return new Pack(id, url, sha1, flag(pack, "required"), prompt.isEmpty() ? Optional.empty() : Optional.of(prompt),
                line(pack, "kick"));
    }

    private static String line(JsonObject body, String field) {
        String line = text(body, field).strip();
        return line.length() > MAX_PROMPT ? line.substring(0, MAX_PROMPT) : line;
    }

    private static Sound soundAt(JsonObject body, String field) {
        JsonElement element = body.get(field);
        return element != null && element.isJsonObject() ? sound(element.getAsJsonObject()) : null;
    }

    private static Sound sound(JsonObject one) {
        String id = text(one, "sound");
        if (!SOUND.matcher(id).matches()) return null;
        return new Sound(id, clamp(number(one, "volume", 1), 0, 1), clamp(number(one, "pitch", 1), 0.5, 2));
    }

    private static double clamp(double value, double low, double high) {
        return Double.isFinite(value) ? Math.max(low, Math.min(high, value)) : 1;
    }

    private static String text(JsonObject body, String field) {
        JsonElement value = body.get(field);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : "";
    }

    private static boolean flag(JsonObject body, String field) {
        JsonElement value = body.get(field);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean() && value.getAsBoolean();
    }

    private static double number(JsonObject body, String field, double fallback) {
        JsonElement value = body.get(field);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber() ? value.getAsDouble() : fallback;
    }

    /** Whether the server's environment leaves its sounds on: they are unless
     *  {@code POLARIS_SOUNDS=off}. */
    static boolean wanted(Map<String, String> env) {
        return !env.getOrDefault("POLARIS_SOUNDS", "").trim().equalsIgnoreCase("off");
    }
}
