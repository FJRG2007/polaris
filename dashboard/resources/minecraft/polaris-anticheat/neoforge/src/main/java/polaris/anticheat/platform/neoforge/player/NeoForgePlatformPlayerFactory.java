package polaris.anticheat.platform.neoforge.player;

import com.mojang.authlib.GameProfile;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;
import org.jetbrains.annotations.NotNull;
import polaris.anticheat.platform.api.player.AbstractPlatformPlayerFactory;
import polaris.anticheat.platform.api.player.OfflinePlatformPlayer;
import polaris.anticheat.platform.api.player.PlatformPlayer;
import polaris.anticheat.platform.neoforge.NeoForgeServer;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** The upstream Fabric platform's player factory, on the running server. */
public final class NeoForgePlatformPlayerFactory extends AbstractPlatformPlayerFactory<ServerPlayer> {

    private final Map<UUID, OfflinePlatformPlayer> offlineCache = new ConcurrentHashMap<>();

    @Override
    protected ServerPlayer getNativePlayer(@NotNull UUID uuid) {
        MinecraftServer server = NeoForgeServer.get();
        return server == null ? null : server.getPlayerList().getPlayer(uuid);
    }

    @Override
    protected ServerPlayer getNativePlayer(@NotNull String name) {
        MinecraftServer server = NeoForgeServer.get();
        return server == null ? null : server.getPlayerList().getPlayerByName(name);
    }

    @Override
    protected PlatformPlayer createPlatformPlayer(@NotNull ServerPlayer nativePlayer) {
        return new NeoForgePlatformPlayer(nativePlayer);
    }

    @Override
    protected UUID getPlayerUUID(@NotNull ServerPlayer nativePlayer) {
        return nativePlayer.getUUID();
    }

    @Override
    protected Collection<ServerPlayer> getNativeOnlinePlayers() {
        MinecraftServer server = NeoForgeServer.get();
        return server == null ? List.of() : server.getPlayerList().getPlayers();
    }

    @Override
    public void replaceNativePlayer(@NotNull UUID uuid, @NotNull ServerPlayer player) {
        PlatformPlayer cached = cache.getPlayer(uuid);
        if (cached != null) cached.replaceNativePlayer(player);
    }

    @Override
    public OfflinePlatformPlayer getOfflineFromUUID(@NotNull UUID uuid) {
        OfflinePlatformPlayer online = getFromUUID(uuid);
        if (online != null) {
            offlineCache.remove(uuid);
            return online;
        }
        return offlineCache.computeIfAbsent(uuid, id -> new NeoForgeOfflinePlatformPlayer(id, ""));
    }

    @Override
    public OfflinePlatformPlayer getOfflineFromName(@NotNull String name) {
        OfflinePlatformPlayer online = getFromName(name);
        if (online != null) {
            offlineCache.remove(online.getUniqueId());
            return online;
        }
        MinecraftServer server = NeoForgeServer.get();
        Optional<GameProfile> profile = server != null && server.usesAuthentication() && server.getProfileCache() != null
                ? server.getProfileCache().get(name)
                : Optional.empty();
        UUID uuid = profile.map(GameProfile::getId)
                .orElseGet(() -> UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(StandardCharsets.UTF_8)));
        String known = profile.map(GameProfile::getName).orElse(name);
        OfflinePlatformPlayer player = new NeoForgeOfflinePlatformPlayer(uuid, known);
        offlineCache.put(uuid, player);
        return player;
    }

    @Override
    public Collection<OfflinePlatformPlayer> getOfflinePlayers() {
        Set<OfflinePlatformPlayer> players = new HashSet<>();
        MinecraftServer server = NeoForgeServer.get();
        if (server != null) {
            File dir = server.getWorldPath(LevelResource.PLAYER_DATA_DIR).toFile();
            String[] files = dir.list((d, name) -> name.endsWith(".dat"));
            if (files != null) {
                for (String file : files) {
                    try {
                        players.add(getOfflineFromUUID(UUID.fromString(file.substring(0, file.length() - 4))));
                    } catch (IllegalArgumentException ignored) {
                        // Not a player's file.
                    }
                }
            }
        }
        players.addAll(getOnlinePlayers());
        return players;
    }
}
