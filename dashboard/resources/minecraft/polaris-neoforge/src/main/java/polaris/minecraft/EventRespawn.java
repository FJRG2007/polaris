package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.portal.TeleportTransition;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.event.entity.player.PlayerRespawnPositionEvent;

/**
 * Where an event's players come back after a death, chosen as they respawn.
 *
 * {@code polaris respawn set <key> <player> <dimension> <x> <y> <z> <yaw>}
 * sends that player's next respawns to the spot while the event under
 * {@code key} lasts: their base in a duel or capture the flag, the gallery in
 * SkyWars. The spot is put into the respawn itself
 * ({@link PlayerRespawnPositionEvent}), never into the player's spawn point,
 * so the bed or anchor they set is theirs untouched before, during and after
 * the event - unlike the game's {@code spawnpoint}, which overwrites it.
 *
 * A spot is only used while the player still carries the arena tag
 * {@link #ARENA_TAG}, and is forgotten as they leave the server, as the event
 * ends ({@code polaris respawn clear <key>}), or the first time they respawn
 * without the tag. {@code polaris respawn list <key>} names who has one, so
 * the dashboard sets it again for whoever came back.
 */
final class EventRespawn {
    /** Kept in step with `IN_ARENA` in the dashboard (`kinds/arena.ts`). */
    static final String ARENA_TAG = "pe_arena";

    private record Spot(String key, String name, ResourceKey<Level> level, Vec3 at, float yaw) {}

    private static final Map<UUID, Spot> spots = new ConcurrentHashMap<>();

    private EventRespawn() {}

    static JsonObject set(
            MinecraftServer server, String key, String name, ResourceLocation dimension, double x, double y, double z,
            float yaw) {
        ServerPlayer player = server.getPlayerList().getPlayerByName(name);
        if (player == null) return refused("offline");
        ResourceKey<Level> level = ResourceKey.create(Registries.DIMENSION, dimension);
        if (server.getLevel(level) == null) return refused("badWorld");
        spots.put(player.getUUID(), new Spot(key, player.getGameProfile().getName(), level, new Vec3(x, y, z), yaw));
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        return reply;
    }

    static JsonObject list(String key) {
        JsonObject reply = new JsonObject();
        JsonArray players = new JsonArray();
        for (Spot spot : spots.values()) if (spot.key().equals(key)) players.add(spot.name());
        reply.addProperty("ok", true);
        reply.add("players", players);
        return reply;
    }

    static JsonObject clear(String key) {
        int before = spots.size();
        spots.values().removeIf(spot -> spot.key().equals(key));
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("cleared", before - spots.size());
        return reply;
    }

    /** Gone from the server: their spot with them. */
    static void left(UUID player) {
        spots.remove(player);
    }

    /**
     * The respawn moved onto the event's spot. The transition the game chose
     * is replaced, never the spawn point: whether the old one is copied to the
     * new player stays the game's call ({@code copyOriginalSpawnPosition}), and
     * a bed found missing is still said to be missing.
     */
    static void respawning(PlayerRespawnPositionEvent event) {
        if (event.isFromEndFight() || !(event.getEntity() instanceof ServerPlayer player)) return;
        Spot spot = spots.get(player.getUUID());
        if (spot == null) return;
        if (!player.getTags().contains(ARENA_TAG)) {
            spots.remove(player.getUUID());
            return;
        }
        ServerLevel level = player.server.getLevel(spot.level());
        if (level == null) return;
        TeleportTransition chosen = event.getTeleportTransition();
        event.setTeleportTransition(new TeleportTransition(
                level, spot.at(), Vec3.ZERO, spot.yaw(), 0.0F, chosen.missingRespawnBlock(), false, Set.of(),
                chosen.postTeleportTransition()));
    }

    private static JsonObject refused(String why) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", false);
        reply.addProperty("why", why);
        return reply;
    }
}
