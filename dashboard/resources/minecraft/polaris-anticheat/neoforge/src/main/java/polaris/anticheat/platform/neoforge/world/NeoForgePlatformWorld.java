package polaris.anticheat.platform.neoforge.world;

import com.github.retrooper.packetevents.protocol.world.states.WrappedBlockState;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jetbrains.annotations.Nullable;
import polaris.anticheat.platform.api.world.PlatformChunk;
import polaris.anticheat.platform.api.world.PlatformWorld;
import polaris.anticheat.platform.neoforge.NeoForgeServer;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** One per level, so the engine can compare worlds by identity as it does elsewhere. */
public final class NeoForgePlatformWorld implements PlatformWorld {

    private static final Map<ServerLevel, NeoForgePlatformWorld> WORLDS = new ConcurrentHashMap<>();

    private final ServerLevel level;

    private NeoForgePlatformWorld(ServerLevel level) {
        this.level = level;
    }

    public static NeoForgePlatformWorld of(ServerLevel level) {
        return WORLDS.computeIfAbsent(level, NeoForgePlatformWorld::new);
    }

    public static void forget(ServerLevel level) {
        WORLDS.remove(level);
    }

    public ServerLevel level() {
        return level;
    }

    @Override
    public boolean isChunkLoaded(int chunkX, int chunkZ) {
        return level.getChunkSource().hasChunk(chunkX, chunkZ);
    }

    @Override
    public WrappedBlockState getBlockAt(int x, int y, int z) {
        return WrappedBlockState.getByGlobalId(Block.getId(level.getBlockState(new BlockPos(x, y, z))));
    }

    @Override
    public String getName() {
        return level.dimension().location().toString();
    }

    @Override
    public @Nullable UUID getUID() {
        return null;
    }

    @Override
    public PlatformChunk getChunkAt(int chunkX, int chunkZ) {
        LevelChunk chunk = level.getChunk(chunkX, chunkZ);
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        int baseX = chunkX << 4;
        int baseZ = chunkZ << 4;
        return (x, y, z) -> Block.getId(chunk.getBlockState(pos.set(baseX + x, y, baseZ + z)));
    }

    @Override
    public boolean isLoaded() {
        return NeoForgeServer.get() != null && NeoForgeServer.get().getLevel(level.dimension()) == level;
    }
}
