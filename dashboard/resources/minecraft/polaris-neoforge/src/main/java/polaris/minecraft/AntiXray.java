package polaris.minecraft;

import it.unimi.dsi.fastutil.longs.Long2ByteOpenHashMap;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.WeakHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientGamePacketListener;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundBundlePacket;
import net.minecraft.network.protocol.game.ClientboundLevelChunkPacketData;
import net.minecraft.network.protocol.game.ClientboundSectionBlocksUpdatePacket;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.common.Tags;
import net.neoforged.neoforge.event.level.ChunkEvent;
import net.neoforged.neoforge.event.level.ChunkWatchEvent;
import net.neoforged.neoforge.event.server.ServerStartingEvent;
import polaris.minecraft.mixin.SectionBlocksUpdateAccessor;

/**
 * Polaris's anti-xray on a NeoForge server: every ore no player could see is sent
 * as the rock around it, so an X-Ray client has nothing to show.
 *
 * - Chunks: an ore (anything tagged c:ores, modded ones included) whose six faces
 *   all touch blocks that render solid is written as stone, deepslate or
 *   netherrack. Sections whose palette holds no ore are not read at all.
 * - Every single-block and section update the server sends goes through the same
 *   test, so asking the server about a position ("cancel digging" at a guessed
 *   spot, which makes it answer with the block there) gets rock back.
 * - A block that stops covering an ore - mined, exploded, flooded - has the ore
 *   next to it sent again, now for real.
 * - An ore at a chunk edge whose neighbour chunk is not loaded yet is hidden, and
 *   shown to a player as soon as that neighbour is sent to them, if that side is
 *   open.
 * - Polaris's X-Ray honeypots are never hidden (AntiXrayLink), so they are the only
 *   buried ore an X-Ray client still shows.
 *
 * Everything that reads the world runs on the server thread; anything asked from
 * another thread is passed through untouched.
 */
public final class AntiXray {
    private static volatile boolean on;
    private static final Direction[] SIDES = {Direction.WEST, Direction.EAST, Direction.NORTH, Direction.SOUTH};
    /** Per level: chunk -> the sides (bit per SIDES index) where an ore was hidden against an unloaded neighbour. */
    private static final Map<ServerLevel, Long2ByteOpenHashMap> PENDING = new WeakHashMap<>();
    /** The sections of the chunk being written, so its size and its bytes come from the same copies. */
    private static final ThreadLocal<Prepared> PREPARED = new ThreadLocal<>();

    private record Prepared(LevelChunk chunk, LevelChunkSection[] sections) {
    }

    AntiXray() {
    }

    /** On unless Polaris switched it off for this server. */
    static boolean wanted(Map<String, String> env) {
        // Its own switch, and the anti-cheat's, which the server's Anti-cheat card writes.
        for (String key : new String[] {"POLARIS_ANTIXRAY", "POLARIS_ANTICHEAT"}) {
            if (env.getOrDefault(key, "").trim().toLowerCase(Locale.ROOT).equals("off")) return false;
        }
        return true;
    }

    /**
     * Switch it on once the server starts, if every hook made it into the game. The
     * hooks are optional so a mismatch cannot stop the server; a partial set would
     * write chunks whose size disagrees with their bytes, so it is all or nothing.
     */
    @SubscribeEvent
    public void onServerStarting(ServerStartingEvent event) {
        if (!hooked()) {
            PolarisMod.LOG.error("Polaris anti-xray is off: this NeoForge build or another mod changed the code it hooks into.");
            return;
        }
        on = true;
        PolarisMod.LOG.info("Polaris anti-xray is on: buried ore is sent as rock.");
    }

    private static boolean hooked() {
        return has(ClientboundLevelChunkPacketData.class, "polaris$size")
                && has(ClientboundLevelChunkPacketData.class, "polaris$write")
                && has(ServerCommonPacketListenerImpl.class, "polaris$filter")
                && has(ServerGamePacketListenerImpl.class, "polaris$probe")
                && has(ServerLevel.class, "polaris$reveal")
                && SectionBlocksUpdateAccessor.class.isAssignableFrom(ClientboundSectionBlocksUpdatePacket.class);
    }

    private static boolean has(Class<?> target, String handler) {
        for (Method method : target.getDeclaredMethods()) {
            if (method.getName().endsWith(handler)) return true;
        }
        return false;
    }

    public static boolean on() {
        return on;
    }

    static boolean isOre(BlockState state) {
        return state.is(Tags.Blocks.ORES);
    }

    private static boolean covers(BlockState state) {
        return state.isSolidRender();
    }

    static BlockState fakeOf(BlockState ore) {
        if (ore.is(Tags.Blocks.ORES_IN_GROUND_DEEPSLATE)) return Blocks.DEEPSLATE.defaultBlockState();
        if (ore.is(Tags.Blocks.ORES_IN_GROUND_NETHERRACK) || ore.is(Blocks.ANCIENT_DEBRIS)) {
            return Blocks.NETHERRACK.defaultBlockState();
        }
        return Blocks.STONE.defaultBlockState();
    }

    // ---- Chunks ------------------------------------------------------------------

    /** The size of the chunk's sections as they will be written. */
    public static int serializedSize(LevelChunk chunk) {
        int size = 0;
        for (LevelChunkSection section : sectionsFor(chunk)) size += section.getSerializedSize();
        return size;
    }

    /** Write the chunk's sections with buried ore as rock. */
    public static void write(FriendlyByteBuf buffer, LevelChunk chunk) {
        for (LevelChunkSection section : sectionsFor(chunk)) section.write(buffer);
        PREPARED.remove();
    }

    private static LevelChunkSection[] sectionsFor(LevelChunk chunk) {
        Prepared prepared = PREPARED.get();
        if (prepared != null && prepared.chunk() == chunk) return prepared.sections();
        LevelChunkSection[] sections = hide(chunk);
        PREPARED.set(new Prepared(chunk, sections));
        return sections;
    }

    private static LevelChunkSection[] hide(LevelChunk chunk) {
        LevelChunkSection[] sections = chunk.getSections();
        if (!(chunk.getLevel() instanceof ServerLevel level) || !level.getServer().isSameThread()) return sections;

        ChunkPos at = chunk.getPos();
        LevelChunk[] beside = new LevelChunk[SIDES.length];
        for (int i = 0; i < SIDES.length; i++) {
            beside[i] = level.getChunkSource().getChunkNow(at.x + SIDES[i].getStepX(), at.z + SIDES[i].getStepZ());
        }
        byte pending = 0;
        LevelChunkSection[] out = sections;
        int minY = level.getMinY();

        for (int s = 0; s < sections.length; s++) {
            LevelChunkSection section = sections[s];
            if (section == null || section.hasOnlyAir() || !section.maybeHas(AntiXray::isOre)) continue;
            List<BlockState> kinds = new ArrayList<>(4);
            int[] left = {0};
            section.getStates().count((state, count) -> {
                if (isOre(state)) {
                    kinds.add(state);
                    left[0] += count;
                }
            });
            LevelChunkSection copy = null;
            scan:
            for (int y = 0; y < 16; y++) {
                for (int z = 0; z < 16; z++) {
                    for (int x = 0; x < 16; x++) {
                        if (left[0] == 0) break scan;
                        BlockState state = section.getBlockState(x, y, z);
                        if (!kinds.contains(state)) continue;
                        left[0]--;
                        int column = (s << 4) + y;
                        if (isOpen(sections, column + 1, x, z) || isOpen(sections, column - 1, x, z)) continue;
                        byte against = 0;
                        boolean open = false;
                        for (int i = 0; i < SIDES.length && !open; i++) {
                            int nx = x + SIDES[i].getStepX();
                            int nz = z + SIDES[i].getStepZ();
                            if (nx >= 0 && nx < 16 && nz >= 0 && nz < 16) {
                                open = isOpen(sections, column, nx, nz);
                            } else if (beside[i] == null) {
                                against |= (byte) (1 << i);
                            } else {
                                open = isOpen(beside[i].getSections(), column, nx & 15, nz & 15);
                            }
                        }
                        if (open) continue;
                        int worldX = at.getMinBlockX() + x;
                        int worldZ = at.getMinBlockZ() + z;
                        if (AntiXrayLink.isTrap(level, worldX, minY + column, worldZ)) continue;
                        if (copy == null) copy = section.copy();
                        copy.setBlockState(x, y, z, fakeOf(state), false);
                        pending |= against;
                    }
                }
            }
            if (copy != null) {
                if (out == sections) out = sections.clone();
                out[s] = copy;
            }
        }

        if (pending != 0) {
            Long2ByteOpenHashMap levelPending = PENDING.computeIfAbsent(level, ignored -> new Long2ByteOpenHashMap());
            levelPending.put(at.toLong(), (byte) (levelPending.get(at.toLong()) | pending));
        }
        return out;
    }

    private static boolean isOpen(LevelChunkSection[] sections, int column, int x, int z) {
        if (column < 0 || column >= sections.length << 4) return true;
        LevelChunkSection section = sections[column >> 4];
        return section == null || !covers(section.getBlockState(x, column & 15, z));
    }

    /** Whether the world has this ore closed in on every side, so the client is sent rock. */
    static boolean isBuried(ServerLevel level, BlockPos pos) {
        for (Direction side : Direction.values()) {
            BlockPos next = pos.relative(side);
            if (next.getY() < level.getMinY() || next.getY() > level.getMaxY()) return false;
            LevelChunk chunk = level.getChunkSource().getChunkNow(next.getX() >> 4, next.getZ() >> 4);
            if (chunk != null && !covers(chunk.getBlockState(next))) return false;
        }
        return !AntiXrayLink.isTrap(level, pos.getX(), pos.getY(), pos.getZ());
    }

    // ---- Block updates -----------------------------------------------------------

    /** What a player is sent instead of a packet: the same one with buried ore as rock. */
    public static Packet<?> filter(Packet<?> packet, ServerPlayer player) {
        if (!on || player == null) return packet;
        ServerLevel level = player.serverLevel();
        if (!level.getServer().isSameThread()) return packet;
        return rewrite(packet, level);
    }

    @SuppressWarnings("unchecked")
    private static Packet<?> rewrite(Packet<?> packet, ServerLevel level) {
        if (packet instanceof ClientboundBlockUpdatePacket update) {
            BlockState state = update.getBlockState();
            if (isOre(state) && isBuried(level, update.getPos())) {
                return new ClientboundBlockUpdatePacket(update.getPos(), fakeOf(state));
            }
        } else if (packet instanceof ClientboundSectionBlocksUpdatePacket section) {
            SectionBlocksUpdateAccessor fields = (SectionBlocksUpdateAccessor) section;
            BlockState[] states = fields.polaris$states();
            short[] positions = fields.polaris$positions();
            SectionPos where = fields.polaris$sectionPos();
            // The packet goes to every player watching the section; the test is the
            // same for all of them, so it is rewritten once, in place.
            for (int i = 0; i < states.length; i++) {
                if (isOre(states[i]) && isBuried(level, where.relativeToBlockPos(positions[i]))) {
                    states[i] = fakeOf(states[i]);
                }
            }
        } else if (packet instanceof ClientboundBundlePacket bundle) {
            List<Packet<? super ClientGamePacketListener>> parts = new ArrayList<>();
            boolean changed = false;
            for (Packet<? super ClientGamePacketListener> part : bundle.subPackets()) {
                Packet<?> next = rewrite(part, level);
                changed |= next != part;
                parts.add((Packet<? super ClientGamePacketListener>) next);
            }
            if (changed) return new ClientboundBundlePacket(parts);
        }
        return packet;
    }

    /** A block stopped covering what is next to it: send the ore beside it again, for real. */
    public static void onBlockChanged(ServerLevel level, BlockPos pos, BlockState before, BlockState after) {
        if (!on || !covers(before) || covers(after)) return;
        for (Direction side : Direction.values()) {
            BlockPos next = pos.relative(side);
            LevelChunk chunk = level.getChunkSource().getChunkNow(next.getX() >> 4, next.getZ() >> 4);
            if (chunk != null && isOre(chunk.getBlockState(next))) level.getChunkSource().blockChanged(next);
        }
    }

    /**
     * A player started, stopped or cancelled digging somewhere. At buried ore that
     * is a probe: nothing a player looks at can land on a block closed in on every
     * side, and the server has already applied every block they broke before.
     */
    public static void onDig(ServerPlayer player, ServerboundPlayerActionPacket.Action action, BlockPos pos) {
        if (!on || player == null) return;
        if (action != ServerboundPlayerActionPacket.Action.START_DESTROY_BLOCK
                && action != ServerboundPlayerActionPacket.Action.ABORT_DESTROY_BLOCK
                && action != ServerboundPlayerActionPacket.Action.STOP_DESTROY_BLOCK) {
            return;
        }
        ServerLevel level = player.serverLevel();
        // Off the server thread the handler hands the packet over and runs again on it.
        if (!level.getServer().isSameThread()) return;
        LevelChunk chunk = level.getChunkSource().getChunkNow(pos.getX() >> 4, pos.getZ() >> 4);
        if (chunk == null || !isOre(chunk.getBlockState(pos)) || !isBuried(level, pos)) return;
        AntiXrayLink.probed(player.getGameProfile().getName(), player.getUUID(), pos);
    }

    // ---- Chunk edges -------------------------------------------------------------

    /**
     * A chunk reached a player: the ore its neighbours hid against it, while it was
     * not loaded, is shown to them where this chunk leaves it open.
     */
    @SubscribeEvent
    public void onChunkSent(ChunkWatchEvent.Sent event) {
        if (!on) return;
        ServerLevel level = event.getLevel();
        Long2ByteOpenHashMap levelPending = PENDING.get(level);
        if (levelPending == null || levelPending.isEmpty()) return;
        ChunkPos at = event.getPos();
        for (int i = 0; i < SIDES.length; i++) {
            Direction toward = SIDES[i];
            ChunkPos nextPos = new ChunkPos(at.x - toward.getStepX(), at.z - toward.getStepZ());
            byte sides = levelPending.get(nextPos.toLong());
            if ((sides & (1 << i)) == 0) continue;
            LevelChunk next = level.getChunkSource().getChunkNow(nextPos.x, nextPos.z);
            if (next != null) showEdge(event.getPlayer(), level, next, toward);
        }
    }

    /** Send a player the ore on one edge of a chunk that is open on that side. */
    private static void showEdge(ServerPlayer player, ServerLevel level, LevelChunk chunk, Direction side) {
        ChunkPos at = chunk.getPos();
        int x0 = side == Direction.EAST ? 15 : 0;
        int z0 = side == Direction.SOUTH ? 15 : 0;
        boolean alongZ = side.getAxis() == Direction.Axis.X;
        for (int y = level.getMinY(); y <= level.getMaxY(); y++) {
            for (int i = 0; i < 16; i++) {
                BlockPos pos = new BlockPos(at.getMinBlockX() + (alongZ ? x0 : i), y, at.getMinBlockZ() + (alongZ ? i : z0));
                BlockState state = chunk.getBlockState(pos);
                if (isOre(state) && !isBuried(level, pos)) player.connection.send(new ClientboundBlockUpdatePacket(pos, state));
            }
        }
    }

    @SubscribeEvent
    public void onChunkUnload(ChunkEvent.Unload event) {
        if (event.getLevel() instanceof ServerLevel level) {
            Long2ByteOpenHashMap levelPending = PENDING.get(level);
            if (levelPending != null) levelPending.remove(event.getChunk().getPos().toLong());
        }
    }

    /** Which of Polaris's honeypot lists a level uses, or -1. */
    static int trapDimension(Level level) {
        if (level.dimension() == Level.OVERWORLD) return 0;
        if (level.dimension() == Level.NETHER) return 1;
        return -1;
    }
}
