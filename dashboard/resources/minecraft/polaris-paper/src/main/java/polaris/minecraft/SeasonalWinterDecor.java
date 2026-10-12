package polaris.minecraft;

import java.util.HashSet;
import java.util.Random;
import java.util.Set;
import java.util.function.BiConsumer;
import org.bukkit.HeightMap;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Lightable;
import org.bukkit.block.data.Snowable;
import org.bukkit.block.data.type.Lantern;
import org.bukkit.block.data.type.Snow;

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

    private static final Material[] GLOWS = {
        Material.OCHRE_FROGLIGHT, Material.VERDANT_FROGLIGHT, Material.PEARLESCENT_FROGLIGHT, Material.REDSTONE_LAMP
    };

    private SeasonalWinterDecor() {}

    static void decide(World world, int cx, int cz, BiConsumer<Block, BlockData> show) {
        WinterPlan plan = SeasonalWinter.plan();
        int spots = WinterPlan.cap(SNOW_SPOTS, plan.snow());
        if (spots == 0 && !plan.lights()) return;
        long chunk = ((long) cx & 0xFFFFFFFFL) | (((long) cz & 0xFFFFFFFFL) << 32);
        Random random = new Random(world.getSeed() ^ (chunk * 0x9E3779B97F4A7C15L) ^ SALT);
        int baseX = cx << 4;
        int baseZ = cz << 4;
        Set<Block> taken = new HashSet<>();
        for (int tries = 0; tries < spots * 2 && spots > 0; tries++) {
            Block ground = SeasonalDecor.groundAt(world, baseX + random.nextInt(16), baseZ + random.nextInt(16));
            if (ground == null || !taken.add(ground) || !SeasonalDecor.naturalGrass(ground)) continue;
            Snow snow = (Snow) Material.SNOW.createBlockData();
            snow.setLayers(1);
            show.accept(ground.getRelative(0, 1, 0), snow);
            if (ground.getBlockData() instanceof Snowable snowable) {
                Snowable snowy = (Snowable) snowable.clone();
                snowy.setSnowy(true);
                show.accept(ground, snowy);
            }
            spots--;
        }
        if (!plan.lights() || random.nextInt(100) >= LIGHT_CHUNKS) return;
        int lights = 1 + random.nextInt(LIGHTS_PER_CHUNK);
        for (int tries = 0; tries < 10 && lights > 0; tries++) {
            int x = baseX + random.nextInt(16);
            int z = baseZ + random.nextInt(16);
            if (random.nextInt(LANTERN_ODDS) == 0) {
                // Hung three clear blocks up, under the lowest leaves: over anybody's head.
                Block under = SeasonalDecor.webUnder(world, x, z);
                if (under == null) continue;
                Lantern lantern = (Lantern) (random.nextBoolean() ? Material.LANTERN : Material.SOUL_LANTERN).createBlockData();
                lantern.setHanging(true);
                show.accept(under, lantern);
            } else {
                // One leaf at the top of a tree lit up: a full block in a full block's place.
                Block top = world.getHighestBlockAt(x, z, HeightMap.MOTION_BLOCKING);
                if (!taken.add(top) || !SeasonalDecor.wild(top.getBlockData())) continue;
                BlockData glow = GLOWS[random.nextInt(GLOWS.length)].createBlockData();
                if (glow instanceof Lightable lamp) lamp.setLit(true);
                show.accept(top, glow);
            }
            lights--;
        }
    }
}
