package polaris.minecraft;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.authlib.GameProfile;
import com.mojang.authlib.properties.Property;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import net.minecraft.network.protocol.game.ClientboundChangeDifficultyPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerAbilitiesPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoRemovePacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundRespawnPacket;
import net.minecraft.network.protocol.game.ClientboundSetExperiencePacket;
import net.minecraft.network.protocol.game.ClientboundSetPassengersPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.GameProfileCache;
import net.minecraft.server.players.PlayerList;
import net.minecraft.util.StringUtil;
import net.minecraft.world.level.storage.LevelData;
import net.minecraft.world.level.storage.LevelResource;
import polaris.minecraft.mixin.ChunkMapAccessor;

/**
 * Player skins chosen from the dashboard, on a server that cannot ask Mojang for
 * them (offline mode gives every profile no textures at all).
 *
 * A skin is a {@code textures} profile property exactly as Mojang signed it: the
 * packed value (a {@code textures.minecraft.net} link and the arm model) and its
 * signature. Since 1.20.2 the client draws another player's skin only when that
 * property is signed - an unsigned one shows the default skin to everybody but
 * the player themselves - so an unsigned skin is never kept.
 *
 * It is kept in {@code world/polaris/skins.json} by player id, put on the profile
 * as the player joins (before anybody is told about them), and changed live by
 * telling every client the player left and came back, re-sending the body to
 * whoever can see it, and walking the player's own client through a respawn on
 * the spot so it draws them with the new skin too.
 *
 * A skin can be set for somebody who is not on, even one the server has never
 * seen: it goes onto the id they were last seen with, or waits under their name
 * ({@code name:<lowercased name>}) and moves onto their id as they join.
 *
 * - {@code polaris skin stage <player> <token> <value>}: the packed value, held a
 *   minute under a token the caller picked.
 * - {@code polaris skin apply <player> <token> <signature>}: puts the value staged
 *   under that token on with its signature. Two lines because value and signature
 *   together are longer than one console command may be; the token keeps two
 *   changes made at once from pairing one's value with the other's signature.
 * - {@code polaris skin clear <player>}
 * - {@code polaris skin get <player>}: what the live profile carries now, or what
 *   is kept for a player who is not on.
 */
public final class PlayerSkins {
    private static final Pattern HASH = Pattern.compile("[0-9a-f]{16,128}");
    private static final Pattern BASE64 = Pattern.compile("[A-Za-z0-9+/]{16,4096}={0,2}");
    private static final Pattern TOKEN = Pattern.compile("[0-9a-f]{8,32}");
    private static final long STAGED_FOR_MS = 60_000;
    private static final String NAMED = "name:";

    /** Values waiting for their signature, by lowercased name and token. */
    private static final Map<String, Staged> STAGED = new ConcurrentHashMap<>();

    private record Staged(String value, long at) {}

    private PlayerSkins() {}

    /** What the entity tracker mixin adds: send this body to one viewer again. */
    public interface Retrack {
        void polaris$retrack(ServerPlayer viewer);
    }

    public static JsonObject stage(MinecraftServer server, String player, String token, String value) {
        String clean = value.trim();
        if (!TOKEN.matcher(token).matches()) return refusal("badToken");
        if (!BASE64.matcher(clean).matches() || skinOf(clean) == null) return refusal("badValue");
        if (!StringUtil.isValidPlayerName(player)) return refusal("badPlayer");
        long now = System.currentTimeMillis();
        STAGED.values().removeIf(staged -> now - staged.at() > STAGED_FOR_MS);
        STAGED.put(stagedKey(player, token), new Staged(clean, now));
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("staged", true);
        return reply;
    }

    public static JsonObject apply(MinecraftServer server, String player, String token, String signature) {
        String clean = signature.trim();
        if (!TOKEN.matcher(token).matches()) return refusal("badToken");
        if (!BASE64.matcher(clean).matches()) return refusal("badSignature");
        Staged staged = STAGED.remove(stagedKey(player, token));
        if (staged == null || System.currentTimeMillis() - staged.at() > STAGED_FOR_MS) return refusal("notStaged");
        ServerPlayer online = server.getPlayerList().getPlayerByName(player);
        JsonObject stored = load(server);
        JsonObject entry = new JsonObject();
        entry.addProperty("value", staged.value());
        entry.addProperty("signature", clean);
        stored.remove(namedKey(player));
        if (online != null) {
            entry.addProperty("name", online.getGameProfile().getName());
            stored.add(online.getUUID().toString(), entry);
        } else {
            // Somebody who is not on: onto the id they were last seen with, or
            // under their name until they join and the id is known.
            String id = storedId(server, stored, player);
            entry.addProperty("name", player);
            stored.add(id != null ? id : namedKey(player), entry);
        }
        if (!save(server, stored)) return refusal("unsaved");
        if (online != null) {
            put(online.getGameProfile(), staged.value(), clean);
            refresh(server, online);
        }
        return get(server, player);
    }

    private static String stagedKey(String player, String token) {
        return player.toLowerCase(Locale.ROOT) + " " + token;
    }

    /** Where a skin set for somebody whose id is not known waits for them. */
    private static String namedKey(String player) {
        return NAMED + player.toLowerCase(Locale.ROOT);
    }

    /**
     * The id a skin is kept under for a player by this name, or null: the name the
     * entry was written with, else the name the server's profile cache has for
     * that id. The cache is only read, never asked to look anybody up.
     */
    private static String storedId(MinecraftServer server, JsonObject stored, String player) {
        GameProfileCache cache = server.getProfileCache();
        for (Map.Entry<String, JsonElement> kept : stored.entrySet()) {
            if (kept.getKey().startsWith(NAMED) || !kept.getValue().isJsonObject()) continue;
            JsonObject entry = kept.getValue().getAsJsonObject();
            if (entry.has("name") && player.equalsIgnoreCase(entry.get("name").getAsString())) return kept.getKey();
            if (cache == null) continue;
            try {
                if (cache.get(UUID.fromString(kept.getKey()))
                        .map(profile -> player.equalsIgnoreCase(profile.getName())).orElse(false)) {
                    return kept.getKey();
                }
            } catch (IllegalArgumentException notAnId) {
                // Not a key this class writes; left alone.
            }
        }
        return null;
    }

    private static JsonObject entryOf(JsonObject stored, String key) {
        JsonElement entry = key == null ? null : stored.get(key);
        return entry != null && entry.isJsonObject() ? entry.getAsJsonObject() : null;
    }

    public static JsonObject clear(MinecraftServer server, String player) {
        ServerPlayer online = server.getPlayerList().getPlayerByName(player);
        JsonObject stored = load(server);
        stored.remove(namedKey(player));
        String id = online != null ? online.getUUID().toString() : storedId(server, stored, player);
        if (id != null) stored.remove(id);
        if (!save(server, stored)) return refusal("unsaved");
        if (online != null) {
            online.getGameProfile().getProperties().removeAll("textures");
            refresh(server, online);
        }
        return get(server, player);
    }

    /**
     * The skin the live profile carries, read back rather than remembered. For a
     * player who is not on, what is kept for them, marked {@code offline}; and
     * {@code pending} too when it waits under their name for a first join.
     */
    public static JsonObject get(MinecraftServer server, String player) {
        ServerPlayer online = server.getPlayerList().getPlayerByName(player);
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        if (online == null) {
            JsonObject stored = load(server);
            JsonObject entry = entryOf(stored, namedKey(player));
            if (entry != null) reply.addProperty("pending", true);
            else entry = entryOf(stored, storedId(server, stored, player));
            reply.addProperty("player", entry != null && entry.has("name") ? entry.get("name").getAsString() : player);
            reply.addProperty("offline", true);
            if (entry != null && entry.has("value")) {
                describe(reply, entry.get("value").getAsString(),
                        entry.has("signature") ? entry.get("signature").getAsString() : null);
            }
            return reply;
        }
        reply.addProperty("player", online.getGameProfile().getName());
        for (Property property : online.getGameProfile().getProperties().get("textures")) {
            describe(reply, property.value(), property.signature());
            break;
        }
        return reply;
    }

    private static void describe(JsonObject reply, String value, String signature) {
        JsonObject skin = skinOf(value);
        if (skin == null) {
            reply.addProperty("unreadable", true);
            return;
        }
        String url = skin.get("url").getAsString();
        reply.addProperty("hash", url.substring(url.lastIndexOf('/') + 1));
        reply.addProperty("model", slim(skin) ? "slim" : "classic");
        reply.addProperty("signed", signature != null && !signature.isEmpty());
    }

    /** As the player joins: the skin kept for them goes on before anybody sees them. */
    public static void joining(MinecraftServer server, ServerPlayer player) {
        try {
            JsonObject stored = load(server);
            String id = player.getUUID().toString();
            String name = player.getGameProfile().getName();
            JsonObject waiting = entryOf(stored, namedKey(name));
            // One kept under the name was set while their id was not known, so
            // after anything kept under the id (a change for a player whose id is
            // known goes onto the id): it wins, and moves onto the id now.
            if (waiting != null) {
                stored.remove(namedKey(name));
                stored.add(id, waiting);
            }
            JsonObject entry = entryOf(stored, id);
            if (entry == null) return;
            // The name rides along so the skin can be found, changed or cleared
            // by name while they are away.
            if (waiting != null || !entry.has("name") || !name.equals(entry.get("name").getAsString())) {
                entry.addProperty("name", name);
                save(server, stored);
            }
            // Without a signature everybody else would see the default skin, so
            // such an entry is left off rather than put on.
            if (!entry.has("value") || !entry.has("signature")) return;
            String value = entry.get("value").getAsString();
            if (skinOf(value) == null) return;
            put(player.getGameProfile(), value, entry.get("signature").getAsString());
        } catch (RuntimeException unexpected) {
            PolarisMod.LOG.warn("Could not put a Polaris skin on a joining player", unexpected);
        }
    }

    private static void put(GameProfile profile, String value, String signature) {
        profile.getProperties().removeAll("textures");
        profile.getProperties().put("textures", new Property("textures", value, signature));
    }

    /** The SKIN entry of a packed value, or null unless it names a Mojang texture. */
    private static JsonObject skinOf(String value) {
        try {
            JsonObject decoded = JsonParser.parseString(new String(
                    Base64.getDecoder().decode(value), StandardCharsets.UTF_8)).getAsJsonObject();
            JsonObject skin = decoded.getAsJsonObject("textures").getAsJsonObject("SKIN");
            String url = skin.get("url").getAsString();
            String hash = url.substring(url.lastIndexOf('/') + 1);
            boolean mojang = url.startsWith("http://textures.minecraft.net/texture/")
                    || url.startsWith("https://textures.minecraft.net/texture/");
            return mojang && HASH.matcher(hash).matches() ? skin : null;
        } catch (RuntimeException unreadable) {
            return null;
        }
    }

    private static boolean slim(JsonObject skin) {
        return skin.has("metadata") && skin.getAsJsonObject("metadata").has("model")
                && "slim".equals(skin.getAsJsonObject("metadata").get("model").getAsString());
    }

    /** Every client forgets the player and learns them again, skin included. */
    private static void refresh(MinecraftServer server, ServerPlayer player) {
        server.getPlayerList().broadcastAll(new ClientboundPlayerInfoRemovePacket(List.of(player.getUUID())));
        server.getPlayerList().broadcastAll(ClientboundPlayerInfoUpdatePacket.createPlayerInitializing(List.of(player)));
        respawnInPlace(server, player);
        if (!(player.level() instanceof ServerLevel level)) return;
        ChunkMap map = level.getChunkSource().chunkMap;
        if (!((Object) map instanceof ChunkMapAccessor trackers)) return;
        Object tracked = trackers.polaris$entityMap().get(player.getId());
        if (!(tracked instanceof Retrack retrack)) return;
        for (ServerPlayer viewer : server.getPlayerList().getPlayers()) {
            if (viewer != player) retrack.polaris$retrack(viewer);
        }
    }

    /**
     * The player's own client keeps the skin of the player entry it found first
     * for as long as the body it controls lives, so a new entry alone changes
     * nothing there: only a respawn gives it a new body, which looks the entry up
     * again. This is one into the level they are in, with everything kept, after
     * which all the client resets on a respawn is sent again, as the server's own
     * respawn and dimension change do.
     *
     * The client opens its level-loading screen on any respawn, and closes it on
     * the first tick after the level info below arrives and the chunk under the
     * player is drawn. In the same level that chunk already is and the client
     * keeps its level, so the screen lasts a tick at most and nothing reloads.
     *
     * Left out, until their next respawn or join: a dead player (the respawn would
     * stand them up on their own client), a sleeping one (it would wake them only
     * there), a rider (the new body would not be on the mount), and a spectator
     * looking through another entity (the client would lose that view).
     */
    private static void respawnInPlace(MinecraftServer server, ServerPlayer player) {
        if (player.isRemoved() || player.isDeadOrDying() || player.isSleeping()
                || player.isPassenger() || player.getCamera() != player) return;
        ServerLevel level = player.serverLevel();
        LevelData data = level.getLevelData();
        PlayerList players = server.getPlayerList();
        // The client shuts whatever it has open on a respawn; the server lets go
        // of it too, or it would go on holding a menu nobody can see.
        if (player.containerMenu != player.inventoryMenu) player.closeContainer();
        player.connection.send(new ClientboundRespawnPacket(player.createCommonSpawnInfo(level),
                ClientboundRespawnPacket.KEEP_ALL_DATA));
        player.connection.teleport(player.getX(), player.getY(), player.getZ(), player.getYRot(), player.getXRot());
        player.connection.send(new ClientboundChangeDifficultyPacket(data.getDifficulty(), data.isDifficultyLocked()));
        player.connection.send(new ClientboundPlayerAbilitiesPacket(player.getAbilities()));
        player.connection.send(new ClientboundSetExperiencePacket(
                player.experienceProgress, player.totalExperience, player.experienceLevel));
        players.sendPlayerPermissionLevel(player);
        players.sendLevelInfo(player, level);
        players.sendAllPlayerInfo(player);
        players.sendActivePlayerEffects(player);
        if (!player.getPassengers().isEmpty()) player.connection.send(new ClientboundSetPassengersPacket(player));
    }

    private static Path file(MinecraftServer server) {
        return server.getWorldPath(LevelResource.ROOT).resolve("polaris").resolve("skins.json");
    }

    private static JsonObject load(MinecraftServer server) {
        Path path = file(server);
        try {
            if (!Files.exists(path)) return new JsonObject();
            return JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (IOException | RuntimeException unreadable) {
            PolarisMod.LOG.warn("Could not read the Polaris skins file", unreadable);
            return new JsonObject();
        }
    }

    /** Written beside and moved over, so a failed write never empties the file. */
    private static boolean save(MinecraftServer server, JsonObject stored) {
        Path path = file(server);
        try {
            Files.createDirectories(path.getParent());
            Path temp = path.resolveSibling("skins.json.tmp");
            Files.writeString(temp, stored.toString(), StandardCharsets.UTF_8);
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            return true;
        } catch (IOException failed) {
            PolarisMod.LOG.error("Could not write the Polaris skins file", failed);
            return false;
        }
    }

    private static JsonObject refusal(String why) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", false);
        reply.addProperty("why", why);
        return reply;
    }
}
