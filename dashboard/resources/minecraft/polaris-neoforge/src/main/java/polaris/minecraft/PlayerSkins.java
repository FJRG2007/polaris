package polaris.minecraft;

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
import java.util.regex.Pattern;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoRemovePacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;
import polaris.minecraft.mixin.ChunkMapAccessor;

/**
 * Player skins chosen from the dashboard, on a server that cannot ask Mojang for
 * them (offline mode gives every profile no textures at all).
 *
 * A skin is a texture already hosted at {@code textures.minecraft.net} - the only
 * host the game client loads skins from - named by its hash, plus the arm model.
 * It is kept in {@code world/polaris/skins.json} by player id, put on the profile
 * as the player joins (before anybody is told about them), and changed live by
 * telling every client the player left and came back, then re-sending the body to
 * whoever can see it. The player's own client keeps the skin it loaded until they
 * rejoin.
 *
 * - {@code polaris skin set <player> <hash> <classic|slim>}
 * - {@code polaris skin clear <player>}
 * - {@code polaris skin get <player>}: what the live profile carries now.
 */
public final class PlayerSkins {
    private static final Pattern HASH = Pattern.compile("[0-9a-f]{16,128}");
    private static final String TEXTURE_ROOT = "http://textures.minecraft.net/texture/";

    private PlayerSkins() {}

    /** What the entity tracker mixin adds: send this body to one viewer again. */
    public interface Retrack {
        void polaris$retrack(ServerPlayer viewer);
    }

    public static JsonObject set(MinecraftServer server, String player, String hash, String model) {
        String clean = hash.toLowerCase(Locale.ROOT);
        if (!HASH.matcher(clean).matches()) return refusal("badHash");
        if (!model.equals("classic") && !model.equals("slim")) return refusal("badModel");
        ServerPlayer online = server.getPlayerList().getPlayerByName(player);
        if (online == null) return refusal("offline");
        JsonObject stored = load(server);
        JsonObject entry = new JsonObject();
        entry.addProperty("hash", clean);
        entry.addProperty("model", model);
        stored.add(online.getUUID().toString(), entry);
        if (!save(server, stored)) return refusal("unsaved");
        put(online.getGameProfile(), clean, model);
        refresh(server, online);
        return get(server, player);
    }

    public static JsonObject clear(MinecraftServer server, String player) {
        ServerPlayer online = server.getPlayerList().getPlayerByName(player);
        if (online == null) return refusal("offline");
        JsonObject stored = load(server);
        stored.remove(online.getUUID().toString());
        if (!save(server, stored)) return refusal("unsaved");
        online.getGameProfile().getProperties().removeAll("textures");
        refresh(server, online);
        return get(server, player);
    }

    /** The skin the live profile carries, read back rather than remembered. */
    public static JsonObject get(MinecraftServer server, String player) {
        ServerPlayer online = server.getPlayerList().getPlayerByName(player);
        if (online == null) return refusal("offline");
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("player", online.getGameProfile().getName());
        for (Property property : online.getGameProfile().getProperties().get("textures")) {
            try {
                JsonObject decoded = JsonParser.parseString(new String(
                        Base64.getDecoder().decode(property.value()), StandardCharsets.UTF_8)).getAsJsonObject();
                JsonObject skin = decoded.getAsJsonObject("textures").getAsJsonObject("SKIN");
                String url = skin.get("url").getAsString();
                reply.addProperty("hash", url.substring(url.lastIndexOf('/') + 1));
                boolean slim = skin.has("metadata")
                        && "slim".equals(skin.getAsJsonObject("metadata").get("model").getAsString());
                reply.addProperty("model", slim ? "slim" : "classic");
            } catch (RuntimeException unreadable) {
                reply.addProperty("unreadable", true);
            }
            break;
        }
        return reply;
    }

    /** As the player joins: the skin kept for them goes on before anybody sees them. */
    public static void joining(MinecraftServer server, ServerPlayer player) {
        try {
            JsonObject stored = load(server);
            if (!stored.has(player.getUUID().toString())) return;
            JsonObject entry = stored.getAsJsonObject(player.getUUID().toString());
            String hash = entry.get("hash").getAsString();
            if (!HASH.matcher(hash).matches()) return;
            put(player.getGameProfile(), hash, entry.get("model").getAsString());
        } catch (RuntimeException unexpected) {
            PolarisMod.LOG.warn("Could not put a Polaris skin on a joining player", unexpected);
        }
    }

    private static void put(GameProfile profile, String hash, String model) {
        JsonObject skin = new JsonObject();
        skin.addProperty("url", TEXTURE_ROOT + hash);
        if (model.equals("slim")) {
            JsonObject metadata = new JsonObject();
            metadata.addProperty("model", "slim");
            skin.add("metadata", metadata);
        }
        JsonObject textures = new JsonObject();
        textures.add("SKIN", skin);
        JsonObject payload = new JsonObject();
        payload.addProperty("timestamp", System.currentTimeMillis());
        payload.addProperty("profileId", profile.getId().toString().replace("-", ""));
        payload.addProperty("profileName", profile.getName());
        payload.add("textures", textures);
        String value = Base64.getEncoder().encodeToString(payload.toString().getBytes(StandardCharsets.UTF_8));
        profile.getProperties().removeAll("textures");
        profile.getProperties().put("textures", new Property("textures", value));
    }

    /** Every client forgets the player and learns them again, skin included. */
    private static void refresh(MinecraftServer server, ServerPlayer player) {
        server.getPlayerList().broadcastAll(new ClientboundPlayerInfoRemovePacket(List.of(player.getUUID())));
        server.getPlayerList().broadcastAll(ClientboundPlayerInfoUpdatePacket.createPlayerInitializing(List.of(player)));
        if (!(player.level() instanceof ServerLevel level)) return;
        ChunkMap map = level.getChunkSource().chunkMap;
        if (!((Object) map instanceof ChunkMapAccessor trackers)) return;
        Object tracked = trackers.polaris$entityMap().get(player.getId());
        if (!(tracked instanceof Retrack retrack)) return;
        for (ServerPlayer viewer : server.getPlayerList().getPlayers()) {
            if (viewer != player) retrack.polaris$retrack(viewer);
        }
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
