package polaris.anticheat.antixray;

import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.world.states.WrappedBlockState;
import com.github.retrooper.packetevents.protocol.world.states.type.StateType;
import com.github.retrooper.packetevents.protocol.world.states.type.StateTypes;

import java.util.Set;

/**
 * What the anti-xray hides, what hides it, and what it is shown as - one lookup
 * per block state id, built once for the ids the server sends.
 *
 * A block is hidden only while every face of it touches a block that fills its
 * whole cube and lets no light through, because then nothing the client renders
 * could show it. That second set is deliberately short: a block missing from it
 * only means an ore beside it stays visible, never that a visible ore vanishes.
 */
public final class AntiXrayBlocks {
    /** Natural blocks that fill their cube and are drawn opaque. */
    private static final Set<String> OCCLUDING = Set.of(
            "stone", "granite", "diorite", "andesite", "deepslate", "cobbled_deepslate", "tuff", "calcite",
            "dirt", "coarse_dirt", "rooted_dirt", "grass_block", "podzol", "mycelium", "gravel", "sand", "red_sand",
            "sandstone", "red_sandstone", "clay", "netherrack", "basalt", "smooth_basalt", "blackstone",
            "gilded_blackstone", "end_stone", "bedrock", "obsidian", "crying_obsidian", "soul_soil", "magma_block",
            "dripstone_block", "moss_block", "cobblestone", "mossy_cobblestone", "infested_stone",
            "infested_deepslate", "infested_cobblestone", "raw_iron_block", "raw_copper_block", "raw_gold_block",
            "amethyst_block", "budding_amethyst", "snow_block", "stone_bricks", "mossy_stone_bricks",
            "cracked_stone_bricks", "deepslate_bricks", "deepslate_tiles", "polished_deepslate", "polished_granite",
            "polished_diorite", "polished_andesite", "sculk", "nether_bricks", "warped_nylium", "crimson_nylium",
            "coal_block", "packed_mud", "mud_bricks", "prismarine", "dark_prismarine", "purpur_block", "end_stone_bricks");

    private static final int MAX_ID = 1 << 17;
    /** Ids past the last real one come back as air; this many in a row ends the scan. */
    private static final int MISSES_TO_STOP = 4096;

    private final boolean[] hidden;
    private final boolean[] occluding;
    private final int[] fake;

    AntiXrayBlocks(ClientVersion version) {
        int stone = idOf(version, StateTypes.STONE);
        int deepslate = idOf(version, StateTypes.DEEPSLATE);
        int netherrack = idOf(version, StateTypes.NETHERRACK);

        int size = 0;
        int misses = 0;
        boolean[] hidden = new boolean[MAX_ID];
        boolean[] occluding = new boolean[MAX_ID];
        int[] fake = new int[MAX_ID];
        for (int id = 0; id < MAX_ID && misses < MISSES_TO_STOP; id++) {
            WrappedBlockState state = stateOf(version, id);
            if (state == null || state.getGlobalId() != id) {
                misses++;
                continue;
            }
            misses = 0;
            size = id + 1;
            String name = state.getType().getName();
            if (isOre(name) && stone > 0) {
                hidden[id] = true;
                occluding[id] = true;
                fake[id] = name.startsWith("deepslate_") && deepslate > 0 ? deepslate
                        : (name.startsWith("nether_") || name.equals("ancient_debris")) && netherrack > 0 ? netherrack
                        : stone;
            } else if (OCCLUDING.contains(name) || name.endsWith("terracotta")) {
                occluding[id] = true;
            }
        }
        this.hidden = java.util.Arrays.copyOf(hidden, size);
        this.occluding = java.util.Arrays.copyOf(occluding, size);
        this.fake = java.util.Arrays.copyOf(fake, size);
    }

    static boolean isOre(String name) {
        return name.endsWith("_ore") || name.equals("ancient_debris");
    }

    /** The id of a block's default state, or 0 (air) where this version has no such block. */
    private static int idOf(ClientVersion version, StateType type) {
        try {
            WrappedBlockState state = WrappedBlockState.getDefaultState(version, type);
            return state == null || state.getType() != type ? 0 : state.getGlobalId();
        } catch (RuntimeException missing) {
            return 0;
        }
    }

    private static WrappedBlockState stateOf(ClientVersion version, int id) {
        try {
            return WrappedBlockState.getByGlobalId(version, id);
        } catch (RuntimeException unknown) {
            return null;
        }
    }

    public boolean isHidden(int id) {
        return id >= 0 && id < hidden.length && hidden[id];
    }

    public boolean isOccluding(int id) {
        return id >= 0 && id < occluding.length && occluding[id];
    }

    /** What a hidden block is sent as: the rock it sits in. */
    public int fakeOf(int id) {
        return fake[id];
    }
}
