package polaris.anticheat.platform.neoforge;

import net.minecraft.server.MinecraftServer;
import org.jetbrains.annotations.Nullable;
import polaris.anticheat.PolarisAPI;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/** The running server, from the moment it starts until it stops. */
public final class NeoForgeServer {

    private static volatile @Nullable MinecraftServer server;

    private NeoForgeServer() {
    }

    public static @Nullable MinecraftServer get() {
        return server;
    }

    public static MinecraftServer require() {
        MinecraftServer current = server;
        if (current == null) throw new IllegalStateException("The server is not running");
        return current;
    }

    static void set(@Nullable MinecraftServer value) {
        server = value;
    }

    public static int tickCount() {
        MinecraftServer current = server;
        return current == null ? 0 : current.getTickCount();
    }

    /** Runs on the server thread at the next end of tick, as the Fabric platform does. */
    public static <U> CompletableFuture<U> supplySync(Supplier<U> supplier) {
        CompletableFuture<U> result = new CompletableFuture<>();
        PolarisAPI.INSTANCE.getScheduler().getGlobalRegionScheduler().run(PolarisAPI.INSTANCE.getPolarisPlugin(), () -> {
            try {
                result.complete(supplier.get());
            } catch (Throwable failed) {
                result.completeExceptionally(failed);
            }
        });
        return result;
    }
}
