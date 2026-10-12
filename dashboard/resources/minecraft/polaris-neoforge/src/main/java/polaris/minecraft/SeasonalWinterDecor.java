package polaris.minecraft;

import java.util.HashSet;
import java.util.Random;
import java.util.Set;
import java.util.function.BiConsumer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LanternBlock;
import net.minecraft.world.level.block.RedstoneLampBlock;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.SnowyDirtBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;

/**
 * Christmas on each player's screen, decided with the rest of a winter chunk in
 * {@link SeasonalDecor}: thin snow on more of the grass, and coloured lights and
 * lanterns on the trees. Shown, never set: the same rules as every other
 * seasonal decoration (natural ground and the leaves the game grew only).
 *
 * The same every time a chunk is asked, from the world's seed and its
 * coordinates, so a light never moves; a setting that changes has
 * {@link SeasonalDecor#redraw} take everything down to be decided again.
 */
final class SeasonalWinterDecor {
    private static final long SALT = 0x5EA50173L;
    /** Snowy patches per chunk at 100%. */
    private static final int SNOW_SPOTS = 6;
    /** Chunks with lights on their trees, in percent, and the most in one. */
    private static final int LIGHT_CHUNKS = 45;
    private static final int LIGHTS_PER_CHUNK = 3;
    /** Of the lights, one in this many is a lantern hung under the leaves. */
    private static final int LANTERN_ODDS = 3;

    private static final Block[] GLOWS = {
        Blocks.OCHRE_FROGLIGHT, Blocks.VERDANT_FROGLIGHT, Blocks.PEARLESCENT_FROGLIGHT, Blocks.REDSTONE_LAMP
    };

    private SeasonalWinterDecor() {}

    static void decide(ServerLevel level, int cx, int cz, BiConsumer<BlockPos, BlockState> show) {
        WinterPlan plan = SeasonalWinter.plan();
        int spots = WinterPlan.cap(SNOW_SPOTS, plan.snow());
        if (spots == 0 && !plan.lights()) return;
        Random random = new Random(level.getSeed() ^ (ChunkPos.asLong(cx, cz) * 0x9E3779B97F4A7C15L) ^ SALT);
        int baseX = cx << 4;
        int baseZ = cz << 4;
        Set<BlockPos> taken = new HashSet<>();
        for (int tries = 0; tries < spots * 2 && spots > 0; tries++) {
            BlockPos ground = SeasonalDecor.groundAt(level, baseX + random.nextInt(16), baseZ + random.nextInt(16));
            if (ground == null || !taken.add(ground) || !SeasonalDecor.naturalGrass(level, ground)) continue;
            BlockState grass = level.getBlockState(ground);
            show.accept(ground.above(), Blocks.SNOW.defaultBlockState().setValue(SnowLayerBlock.LAYERS, 1));
            if (grass.hasProperty(SnowyDirtBlock.SNOWY)) show.accept(ground, grass.setValue(SnowyDirtBlock.SNOWY, true));
            spots--;
        }
        if (!plan.lights() || random.nextInt(100) >= LIGHT_CHUNKS) return;
        int lights = 1 + random.nextInt(LIGHTS_PER_CHUNK);
        for (int tries = 0; tries < 10 && lights > 0; tries++) {
            int x = baseX + random.nextInt(16);
            int z = baseZ + random.nextInt(16);
            if (random.nextInt(LANTERN_ODDS) == 0) {
                // Hung three clear blocks up, under the lowest leaves: over anybody's head.
                BlockPos under = SeasonalDecor.webUnder(level, x, z);
                if (under == null) continue;
                Block lantern = random.nextBoolean() ? Blocks.LANTERN : Blocks.SOUL_LANTERN;
                show.accept(under, lantern.defaultBlockState().setValue(LanternBlock.HANGING, true));
            } else {
                // One leaf at the top of a tree lit up: a full block in a full block's place.
                BlockPos top = new BlockPos(x, level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z) - 1, z);
                if (!taken.add(top) || !SeasonalDecor.wild(level.getBlockState(top))) continue;
                Block glow = GLOWS[random.nextInt(GLOWS.length)];
                BlockState shown = glow == Blocks.REDSTONE_LAMP
                        ? glow.defaultBlockState().setValue(RedstoneLampBlock.LIT, true)
                        : glow.defaultBlockState();
                show.accept(top, shown);
            }
            lights--;
        }
    }
}
