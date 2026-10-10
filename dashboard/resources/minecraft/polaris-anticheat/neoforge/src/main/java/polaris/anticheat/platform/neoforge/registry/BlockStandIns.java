package polaris.anticheat.platform.neoforge.registry;

import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.world.states.WrappedBlockState;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelReader;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.Comparator;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Gives every block state a mod adds a vanilla stand-in for the simulation.
 *
 * Two ways a modded state gets one, each checked against the collision shape:
 * <ul>
 *   <li>its block is a vanilla block class (a trapdoor, a slab, a fence...) the mod
 *       did not change anything movement-related in, so it is simulated as a vanilla
 *       block of that class with the same properties;</li>
 *   <li>nothing about it moves a player but its shape, its friction, speed and jump
 *       factors and the fluid in it, and a vanilla state has the same of each.</li>
 * </ul>
 * Anything else is unmodelled: it is simulated as stone and the player is not
 * predicted while touching it, rather than predicted against a guess. Each stand-in
 * keeps the modded state's own id, so nothing the engine writes back to a client
 * names a different block.
 */
final class BlockStandIns {

    /** Methods a block overrides when it moves, slows, bounces or carries a player. */
    private static final MethodRef[] MOVEMENT_HOOKS = {
            new MethodRef("entityInside", BlockState.class, Level.class, BlockPos.class, Entity.class),
            new MethodRef("stepOn", Level.class, BlockPos.class, BlockState.class, Entity.class),
            new MethodRef("updateEntityMovementAfterFallOn", BlockGetter.class, Entity.class),
            new MethodRef("getFriction", BlockState.class, LevelReader.class, BlockPos.class, Entity.class),
            new MethodRef("isLadder", BlockState.class, LevelReader.class, BlockPos.class, LivingEntity.class),
            new MethodRef("isScaffolding", BlockState.class, LevelReader.class, BlockPos.class, LivingEntity.class),
            new MethodRef("isSlimeBlock", BlockState.class),
            new MethodRef("isStickyBlock", BlockState.class),
            new MethodRef("collisionExtendsVertically", BlockState.class, BlockGetter.class, BlockPos.class, Entity.class),
            new MethodRef("makesOpenTrapdoorAboveClimbable", BlockState.class, LevelReader.class, BlockPos.class, BlockState.class),
    };

    /**
     * Vanilla classes whose override of one of those hooks does nothing to how a player
     * moves: it presses, lights, damages or collects.
     */
    private static final Set<String> HARMLESS_VANILLA_HOOKS = Set.of(
            "ButtonBlock", "BasePressurePlateBlock", "TripWireBlock", "LayeredCauldronBlock", "LavaCauldronBlock",
            "CampfireBlock", "BaseFireBlock", "WitherRoseBlock", "HopperBlock", "DetectorRailBlock", "MagmaBlock",
            "RedStoneOreBlock", "TurtleEggBlock", "SculkSensorBlock");

    private static final String VANILLA_PACKAGE = "net.minecraft.";

    final BitSet modded = new BitSet();
    final BitSet unmodelled = new BitSet();
    /** The stand-in state of each block's default state, for what a block item places. */
    final Map<Block, WrappedBlockState> defaults = new IdentityHashMap<>();
    int vanillaMismatches;
    final List<String> mismatchSamples = new ArrayList<>();
    int matched;
    /** Per mod: states simulated as vanilla, states unmodelled. */
    final Map<String, int[]> perMod = new TreeMap<>();
    /** Why states were left unmodelled, by mod, for the log. */
    final Map<String, int[]> reasons = new TreeMap<>();
    /** One state for each of those reasons. */
    final Map<String, String> samples = new TreeMap<>();

    private final Map<Class<?>, String> hookCache = new IdentityHashMap<>();

    static BlockStandIns install(ClientVersion version) throws ReflectiveOperationException {
        BlockStandIns result = new BlockStandIns();
        result.run(version);
        return result;
    }

    @SuppressWarnings("unchecked")
    private void run(ClientVersion version) throws ReflectiveOperationException {
        // Loads the version's table, then reaches into it.
        WrappedBlockState.getByGlobalId(version, 1, false);
        Method indexOf = WrappedBlockState.class.getDeclaredMethod("getMappingsIndex", ClientVersion.class);
        indexOf.setAccessible(true);
        byte index = (byte) indexOf.invoke(null, version);
        Field byIdField = WrappedBlockState.class.getDeclaredField("BY_ID");
        byIdField.setAccessible(true);
        Map<Integer, WrappedBlockState> byId = ((Map<Integer, WrappedBlockState>[]) byIdField.get(null))[index];

        Map<String, BlockState> vanillaByBehaviour = new HashMap<>();
        Map<String, BlockState> vanillaByClass = new HashMap<>();
        List<BlockState> moddedStates = new ArrayList<>();
        for (BlockState state : Block.BLOCK_STATE_REGISTRY) {
            int id = Block.getId(state);
            ResourceLocation key = BuiltInRegistries.BLOCK.getKey(state.getBlock());
            if (!key.getNamespace().equals(ResourceLocation.DEFAULT_NAMESPACE)) {
                moddedStates.add(state);
                continue;
            }
            WrappedBlockState known = byId.get(id);
            if (known == null || !known.getType().getName().equals(key.getPath())) {
                vanillaMismatches++;
                if (mismatchSamples.size() < 5) mismatchSamples.add(key + "#" + id + "->" + (known == null ? "none" : known.getType().getName()));
                continue;
            }
            if (state.isAir()) continue;
            vanillaByClass.putIfAbsent(state.getBlock().getClass().getName() + "|" + properties(state), state);
            if (whyNotPlain(state) == null) {
                String behaviour = behaviourKey(state);
                if (behaviour != null) vanillaByBehaviour.putIfAbsent(behaviour, state);
            }
        }

        WrappedBlockState stone = byId.get(Block.getId(Blocks.STONE.defaultBlockState()));
        WrappedBlockState air = byId.get(0);
        for (BlockState state : moddedStates) {
            int id = Block.getId(state);
            String mod = BuiltInRegistries.BLOCK.getKey(state.getBlock()).getNamespace();
            int[] counts = perMod.computeIfAbsent(mod, k -> new int[2]);
            modded.set(id);

            WrappedBlockState base = null;
            String why = null;
            if (state.isAir()) {
                base = air;
            } else {
                BlockState vanilla = sameVanillaClass(state, vanillaByClass);
                if (vanilla == null) {
                    why = whyNotPlain(state);
                    if (why == null) {
                        String behaviour = behaviourKey(state);
                        vanilla = behaviour == null ? null : vanillaByBehaviour.get(behaviour);
                        if (vanilla == null) why = behaviour == null ? "shape needs a world" : "nothing vanilla like it";
                    }
                }
                if (vanilla != null) base = byId.get(Block.getId(vanilla));
            }
            if (base == null) {
                reasons.computeIfAbsent(mod + ": " + why, k -> new int[1])[0]++;
                samples.putIfAbsent(mod + ": " + why, state.toString());
                unmodelled.set(id);
                base = stone;
                counts[1]++;
            } else {
                matched++;
                counts[0]++;
            }
            WrappedBlockState standIn = new WrappedBlockState(base.getType(), base.getInternalData(), id, index);
            byId.put(id, standIn);
            if (state == state.getBlock().defaultBlockState()) defaults.put(state.getBlock(), standIn);
        }
    }

    /**
     * The vanilla state of the vanilla class this block is, with the same properties
     * and shape, when the mod changed nothing movement-related on the way down.
     */
    private BlockState sameVanillaClass(BlockState state, Map<String, BlockState> vanillaByClass) {
        Class<?> vanillaClass = state.getBlock().getClass();
        while (vanillaClass != null && !vanillaClass.getName().startsWith(VANILLA_PACKAGE)) {
            for (MethodRef hook : MOVEMENT_HOOKS) {
                if (declares(vanillaClass, hook)) return null;
            }
            vanillaClass = vanillaClass.getSuperclass();
        }
        if (vanillaClass == null || vanillaClass == Block.class) return null;
        BlockState vanilla = vanillaByClass.get(vanillaClass.getName() + "|" + properties(state));
        if (vanilla == null) return null;
        String mine = behaviourKey(state);
        return mine != null && mine.equals(behaviourKey(vanilla)) ? vanilla : null;
    }

    /** What makes the block more than its shape, factors and fluid, or null when nothing does. */
    private String whyNotPlain(BlockState state) {
        Block block = state.getBlock();
        try {
            if (state.hasOffsetFunction()) return "offset";
            if (block.hasDynamicShape()) return "dynamic shape";
            if (state.is(BlockTags.CLIMBABLE)) return "climbable";
        } catch (Throwable failed) {
            return "unreadable";
        }
        return hookCache.computeIfAbsent(block.getClass(), BlockStandIns::movementHookOf);
    }

    private static String movementHookOf(Class<?> blockClass) {
        for (Class<?> c = blockClass; c != null && c != Block.class; c = c.getSuperclass()) {
            if (c.getName().startsWith(VANILLA_PACKAGE) && HARMLESS_VANILLA_HOOKS.contains(c.getSimpleName())) continue;
            for (MethodRef hook : MOVEMENT_HOOKS) {
                if (declares(c, hook)) return hook.name + " in " + c.getSimpleName();
            }
        }
        return null;
    }

    private static boolean declares(Class<?> c, MethodRef hook) {
        try {
            c.getDeclaredMethod(hook.name, hook.params);
            return true;
        } catch (NoSuchMethodException ignored) {
            return false;
        }
    }

    private static String properties(BlockState state) {
        Map<String, String> values = new TreeMap<>();
        for (Map.Entry<Property<?>, Comparable<?>> entry : state.getValues().entrySet()) {
            values.put(entry.getKey().getName(), String.valueOf(entry.getValue()));
        }
        return values.toString();
    }

    /**
     * Everything about a state that moves a player, in a stable form: the collision
     * shape, the friction, speed and jump factors, and the fluid in it (which no player
     * can touch inside a full block). Null when the shape cannot be read without a world.
     */
    private static String behaviourKey(BlockState state) {
        VoxelShape shape;
        Block block = state.getBlock();
        StringBuilder key = new StringBuilder();
        try {
            shape = state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
            key.append(block.getFriction()).append('/').append(block.getSpeedFactor()).append('/').append(block.getJumpFactor()).append('|');
            FluidState fluid = state.getFluidState();
            if (!fluid.isEmpty() && !Block.isShapeFullBlock(shape)) {
                key.append(BuiltInRegistries.FLUID.getKey(fluid.getType())).append(':').append(fluid.getAmount()).append('|');
            }
        } catch (Throwable failed) {
            return null;
        }
        if (shape.isEmpty()) return key.append("empty").toString();
        List<AABB> boxes = new ArrayList<>(shape.optimize().toAabbs());
        boxes.sort(Comparator.<AABB>comparingDouble(b -> b.minX).thenComparingDouble(b -> b.minY)
                .thenComparingDouble(b -> b.minZ).thenComparingDouble(b -> b.maxX)
                .thenComparingDouble(b -> b.maxY).thenComparingDouble(b -> b.maxZ));
        for (AABB b : boxes) {
            key.append(b.minX).append(',').append(b.minY).append(',').append(b.minZ).append(',')
                    .append(b.maxX).append(',').append(b.maxY).append(',').append(b.maxZ).append(';');
        }
        return key.toString();
    }

    private record MethodRef(String name, Class<?>... params) {
    }
}
