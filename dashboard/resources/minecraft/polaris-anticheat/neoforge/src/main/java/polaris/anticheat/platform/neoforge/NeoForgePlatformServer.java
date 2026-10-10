package polaris.anticheat.platform.neoforge;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import net.neoforged.fml.ModList;
import polaris.anticheat.platform.api.PlatformServer;
import polaris.anticheat.platform.api.sender.Sender;

final class NeoForgePlatformServer implements PlatformServer {

    @Override
    public String getPlatformImplementationString() {
        String neoforge = ModList.get().getModContainerById("neoforge")
                .map(container -> container.getModInfo().getVersion().toString())
                .orElse("?");
        MinecraftServer server = NeoForgeServer.get();
        return "NeoForge " + neoforge + " (MC: " + (server == null ? "?" : server.getServerVersion()) + ")";
    }

    @Override
    public void dispatchCommand(Sender sender, String command) {
        MinecraftServer server = NeoForgeServer.get();
        if (server == null) return;
        Object stack = sender.getNativeSender();
        if (stack instanceof CommandSourceStack source) {
            server.getCommands().performPrefixedCommand(source, command);
        }
    }

    @Override
    public Sender getConsoleSender() {
        return NeoForgeLoader.get().getNeoForgeSenderFactory().console();
    }

    @Override
    public void registerOutgoingPluginChannel(String name) {
    }

    @Override
    public double getTPS() {
        MinecraftServer server = NeoForgeServer.get();
        if (server == null) return 20.0;
        double nanos = Math.max(1L, server.getAverageTickTimeNanos());
        return Math.min(20.0, 1_000_000_000.0 / nanos);
    }
}
