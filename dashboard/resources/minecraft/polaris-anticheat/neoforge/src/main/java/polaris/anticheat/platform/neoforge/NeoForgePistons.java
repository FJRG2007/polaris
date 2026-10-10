package polaris.anticheat.platform.neoforge;

import com.github.retrooper.packetevents.protocol.world.BlockFace;
import com.github.retrooper.packetevents.util.Vector3d;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.piston.PistonStructureResolver;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.event.level.PistonEvent;
import polaris.anticheat.PolarisAPI;
import polaris.anticheat.platform.neoforge.utils.NeoForgeConversion;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.collisions.datatypes.SimpleCollisionBox;
import polaris.anticheat.utils.data.PistonData;

import java.util.ArrayList;
import java.util.List;

/**
 * Pistons that move blocks next to a player, so the simulation knows a block shoved
 * them. The upstream Fabric platform takes this from a mixin on the piston's move;
 * NeoForge hands the same resolver to {@link PistonEvent.Pre}.
 */
final class NeoForgePistons {

    private static final double MAX_HORIZONTAL_DISTANCE = 24.0;
    private static final double MAX_VERTICAL_DISTANCE = 64.0;

    private NeoForgePistons() {
    }

    static void onPiston(PistonEvent.Pre event) {
        if (!(event.getLevel() instanceof Level level) || level.isClientSide()) return;
        PistonStructureResolver resolver = event.getStructureHelper();
        if (resolver == null || !resolver.resolve()) return;
        boolean extending = event.getPistonMoveType().isExtend;
        BlockPos pistonPos = event.getPos();
        Direction direction = event.getDirection();

        boolean hasSlimeBlock = false;
        boolean hasHoneyBlock = false;
        List<SimpleCollisionBox> boxes = new ArrayList<>();
        int dx = direction.getStepX();
        int dy = direction.getStepY();
        int dz = direction.getStepZ();
        for (BlockPos blockPos : resolver.getToPush()) {
            int bx = blockPos.getX();
            int by = blockPos.getY();
            int bz = blockPos.getZ();
            boxes.add(new SimpleCollisionBox(bx, by, bz, bx + 1, by + 1, bz + 1, true));
            boxes.add(new SimpleCollisionBox(bx + dx, by + dy, bz + dz, bx + dx + 1, by + dy + 1, bz + dz + 1, true));
            BlockState state = level.getBlockState(blockPos);
            if (state.is(Blocks.SLIME_BLOCK)) hasSlimeBlock = true;
            if (state.is(Blocks.HONEY_BLOCK)) hasHoneyBlock = true;
        }
        if (extending || resolver.getToPush().isEmpty()) {
            BlockPos head = pistonPos.relative(direction);
            boxes.add(new SimpleCollisionBox(head.getX(), head.getY(), head.getZ(), head.getX() + 1, head.getY() + 1, head.getZ() + 1, true));
        }

        int chunkX = pistonPos.getX() >> 4;
        int chunkZ = pistonPos.getZ() >> 4;
        BlockFace face = NeoForgeConversion.fromDirection(direction);
        for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
            Vector3d pos = player.compensatedEntities.self.trackedServerPosition.getPos();
            if (Math.abs(pistonPos.getX() - pos.getX()) > MAX_HORIZONTAL_DISTANCE
                    || Math.abs(pistonPos.getY() - pos.getY()) > MAX_VERTICAL_DISTANCE
                    || Math.abs(pistonPos.getZ() - pos.getZ()) > MAX_HORIZONTAL_DISTANCE
                    || !player.compensatedWorld.isChunkLoaded(chunkX, chunkZ)) {
                continue;
            }
            int lastTrans = player.lastTransactionSent.get();
            PistonData data = new PistonData(face, boxes, lastTrans, extending, hasSlimeBlock, hasHoneyBlock);
            player.latencyUtils.addRealTimeTaskAsync(lastTrans, () -> player.compensatedWorld.activePistons.add(data));
        }
    }
}
