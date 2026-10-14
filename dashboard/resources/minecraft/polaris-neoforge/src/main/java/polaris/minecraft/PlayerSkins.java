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
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
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
 * A skin is a {@code textures} profile property exactly as Mojang signed it: the
 * packed value (a {@code textures.minecraft.net} link and the arm model) and its
 * signature. Since 1.20.2 the client draws another player's skin only when that
 * property is signed - an unsigned one shows the default skin to everybody but
 * the player themselves - so an unsigned skin is never kept.
 *
 * It is kept in {@code world/polaris/skins.json} by player id, put on the profile
 * as the player joins (before anybody is told about them), and changed live by
 * telling every client the player left and came back, then re-sending the body to
 * whoever can see it. The player's own client keeps the skin it loaded until they
 * rejoin.
 *
 * - {@code polaris skin stage <player> <value>}: the packed value, held a minute.
 * - {@code polaris skin apply <player> <signature>}: puts the staged value on with
 *   its signature. Two lines because value and signature together are longer than
 *   one console command may be.
 * - {@code polaris skin clear <player>}
 * - {@code polaris skin get <player>}: what the live profile carries now.
 */
public final class PlayerSkins {
    private static final Pattern HASH = Pattern.compile("[0-9a-f]{16,128}");
    private static final Pattern BASE64 = Pattern.compile("[A-Za-z0-9+/]{16,4096}={0,2}");
    private static final long STAGED_FOR_MS = 60_000;

    /** Values waiting for their signature, by lowercased name. */
    private static final Map<String, Staged> STAGED = new ConcurrentHashMap<>();

    private record Staged(String value, long at) {}

    private PlayerSkins() {}

    /** What the entity tracker mixin adds: send this body to one viewer again. */
    public interface Retrack {
        void polaris$retrack(ServerPlayer viewer);
    }

    public static JsonObject stage(MinecraftServer server, String player, String value) {
        String clean = value.trim();
        if (!BASE64.matcher(clean).matches() || skinOf(clean) == null) return refusal("badValue");
        if (server.getPlayerList().getPlayerByName(player) == null) return refusal("offline");
        STAGED.put(player.toLowerCase(Locale.ROOT), new Staged(clean, System.currentTimeMillis()));
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("staged", true);
        return reply;
    }

    public static JsonObject apply(MinecraftServer server, String player, String signature) {
        String clean = signature.trim();
        if (!BASE64.matcher(clean).matches()) return refusal("badSignature");
        Staged staged = STAGED.remove(player.toLowerCase(Locale.ROOT));
        if (staged == null || System.currentTimeMillis() - staged.at() > STAGED_FOR_MS) return refusal("notStaged");
        ServerPlayer online = server.getPlayerList().getPlayerByName(player);
        if (online == null) return refusal("offline");
        JsonObject stored = load(server);
        JsonObject entry = new JsonObject();
        entry.addProperty("value", staged.value());
        entry.addProperty("signature", clean);
        stored.add(online.getUUID().toString(), entry);
        if (!save(server, stored)) return refusal("unsaved");
        put(online.getGameProfile(), staged.value(), clean);
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
            JsonObject skin = skinOf(property.value());
            if (skin == null) {
                reply.addProperty("unreadable", true);
                break;
            }
            String url = skin.get("url").getAsString();
            reply.addProperty("hash", url.substring(url.lastIndexOf('/') + 1));
            reply.addProperty("model", slim(skin) ? "slim" : "classic");
            reply.addProperty("signed", property.signature() != null && !property.signature().isEmpty());
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
