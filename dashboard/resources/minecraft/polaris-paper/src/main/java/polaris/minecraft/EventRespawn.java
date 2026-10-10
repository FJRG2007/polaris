package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;

/**
 * Where an event's players come back after a death, chosen as they respawn.
 *
 * {@code polaris respawn set <key> <player> <dimension> <x> <y> <z> <yaw>}
 * sends that player's next respawns to the spot while the event under
 * {@code key} lasts: their base in a duel or capture the flag, the gallery in
 * SkyWars. The spot is given to the respawn itself
 * ({@link PlayerRespawnEvent#setRespawnLocation}), never to the player's
 * spawn point, so the bed or anchor they set is theirs untouched before,
 * during and after the event - unlike the game's {@code spawnpoint}, which
 * overwrites it.
 *
 * A spot is only used while the player still carries the arena tag
 * {@link #ARENA_TAG}, and is forgotten as they leave the server, as the event
 * ends ({@code polaris respawn clear <key>}), or the first time they respawn
 * without the tag. {@code polaris respawn list <key>} names who has one, so
 * the dashboard sets it again for whoever came back.
 *
 * Commands and events both run on the main thread.
 */
final class EventRespawn implements Listener {
    /** Kept in step with `IN_ARENA` in the dashboard (`kinds/arena.ts`). */
    static final String ARENA_TAG = "pe_arena";
    /** As the NeoForge mod's keys (`EventStash.KEY`). */
    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final double FAR = 3.0E7;

    private record Spot(String key, String name, NamespacedKey world, double x, double y, double z, float yaw) {}

    private final Map<UUID, Spot> spots = new ConcurrentHashMap<>();

    /** {@code polaris respawn ...}, its arguments after {@code respawn}. */
    JsonObject answer(String[] args) {
        if (args.length == 2 && !KEY.matcher(args[1]).matches()) return SoundPack.refused("badKey");
        if (args.length == 2 && args[0].equalsIgnoreCase("list")) return list(args[1]);
        if (args.length == 2 && args[0].equalsIgnoreCase("clear")) return clear(args[1]);
        if (args.length == 8 && args[0].equalsIgnoreCase("set")) {
            if (!KEY.matcher(args[1]).matches()) return SoundPack.refused("badKey");
            try {
                return set(args[1], args[2], args[3], number(args[4], FAR), number(args[5], 2048),
                        number(args[6], FAR), (float) number(args[7], 360));
            } catch (NumberFormatException bad) {
                return SoundPack.refused("usage");
            }
        }
        return SoundPack.refused("usage");
    }

    private static double number(String text, double bound) {
        double value = Double.parseDouble(text);
        if (!Double.isFinite(value) || Math.abs(value) > bound) throw new NumberFormatException(text);
        return value;
    }

    private JsonObject set(String key, String name, String dimension, double x, double y, double z, float yaw) {
        Player player = Bukkit.getPlayerExact(name);
        if (player == null) return SoundPack.refused("offline");
        NamespacedKey world = NamespacedKey.fromString(dimension);
        if (world == null || worldOf(world) == null) return SoundPack.refused("badWorld");
        spots.put(player.getUniqueId(), new Spot(key, player.getName(), world, x, y, z, yaw));
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        return reply;
    }

    private JsonObject list(String key) {
        JsonArray players = new JsonArray();
        for (Spot spot : spots.values()) if (spot.key().equals(key)) players.add(spot.name());
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.add("players", players);
        return reply;
    }

    private JsonObject clear(String key) {
        int before = spots.size();
        spots.values().removeIf(spot -> spot.key().equals(key));
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("cleared", before - spots.size());
        return reply;
    }

    /** Last of those that change it, so the event's spot is the one used. */
    @EventHandler(priority = EventPriority.HIGHEST)
    public void onRespawn(PlayerRespawnEvent event) {
        Player player = event.getPlayer();
        Spot spot = spots.get(player.getUniqueId());
        if (spot == null) return;
        if (!player.getScoreboardTags().contains(ARENA_TAG)) {
            spots.remove(player.getUniqueId());
            return;
        }
        World world = worldOf(spot.world());
        if (world == null) return;
        event.setRespawnLocation(new Location(world, spot.x(), spot.y(), spot.z(), spot.yaw(), 0.0F));
    }

    /** A loaded world by its key: the Spigot API this compiles against has no
     *  getWorld(NamespacedKey), only Paper's newer one does. */
    private static World worldOf(NamespacedKey key) {
        for (World world : Bukkit.getWorlds()) if (world.getKey().equals(key)) return world;
        return null;
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        spots.remove(event.getPlayer().getUniqueId());
    }
}
