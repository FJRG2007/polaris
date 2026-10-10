package polaris.anticheat.platform.neoforge.player;

import net.minecraft.server.MinecraftServer;
import org.jetbrains.annotations.NotNull;
import polaris.anticheat.platform.api.player.OfflinePlatformPlayer;
import polaris.anticheat.platform.neoforge.NeoForgeServer;

import java.util.UUID;

record NeoForgeOfflinePlatformPlayer(@NotNull UUID uniqueId, @NotNull String name) implements OfflinePlatformPlayer {

    @Override
    public UUID getUniqueId() {
        return uniqueId;
    }

    @Override
    public String getName() {
        return name;
    }

    @Override
    public boolean isOnline() {
        MinecraftServer server = NeoForgeServer.get();
        return server != null && server.getPlayerList().getPlayer(uniqueId) != null;
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof OfflinePlatformPlayer player && uniqueId.equals(player.getUniqueId());
    }

    @Override
    public int hashCode() {
        return uniqueId.hashCode();
    }
}
