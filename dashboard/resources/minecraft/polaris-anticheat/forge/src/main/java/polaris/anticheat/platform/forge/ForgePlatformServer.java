package polaris.anticheat.platform.forge;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import net.minecraftforge.fml.ModList;
import polaris.anticheat.platform.api.PlatformServer;
import polaris.anticheat.platform.api.sender.Sender;

final class ForgePlatformServer implements PlatformServer {

    @Override
    public String getPlatformImplementationString() {
        String forge = ModList.get().getModContainerById("forge")
                .map(container -> container.getModInfo().getVersion().toString())
                .orElse("?");
        MinecraftServer server = ForgeServer.get();
        return "Forge " + forge + " (MC: " + (server == null ? "?" : server.getServerVersion()) + ")";
    }

    @Override
    public void dispatchCommand(Sender sender, String command) {
        MinecraftServer server = ForgeServer.get();
        if (server == null) return;
        Object stack = sender.getNativeSender();
        if (stack instanceof CommandSourceStack source) {
            server.getCommands().performPrefixedCommand(source, command);
        }
    }

    @Override
    public Sender getConsoleSender() {
        return ForgeLoader.get().getForgeSenderFactory().console();
    }

    @Override
    public void registerOutgoingPluginChannel(String name) {
    }

    @Override
    public double getTPS() {
        MinecraftServer server = ForgeServer.get();
        if (server == null) return 20.0;
        double millis = Math.max(0.001, server.getAverageTickTime());
        return Math.min(20.0, 1_000.0 / millis);
    }
}
