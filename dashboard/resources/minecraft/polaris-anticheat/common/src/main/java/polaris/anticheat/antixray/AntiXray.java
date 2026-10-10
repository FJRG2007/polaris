package polaris.anticheat.antixray;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.bridge.PolarisTraps;
import polaris.anticheat.platform.api.Platform;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.latency.CompensatedWorld;
import com.github.retrooper.packetevents.event.PacketListenerAbstract;
import com.github.retrooper.packetevents.event.PacketListenerPriority;
import com.github.retrooper.packetevents.event.PacketSendEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.protocol.packettype.PacketTypeCommon;
import com.github.retrooper.packetevents.protocol.world.chunk.BaseChunk;
import com.github.retrooper.packetevents.protocol.world.chunk.Column;
import com.github.retrooper.packetevents.protocol.world.chunk.impl.v_1_18.Chunk_v1_18;
import com.github.retrooper.packetevents.protocol.world.chunk.palette.GlobalPalette;
import com.github.retrooper.packetevents.protocol.world.chunk.palette.Palette;
import com.github.retrooper.packetevents.protocol.world.dimension.DimensionType;
import com.github.retrooper.packetevents.util.Vector3i;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerAcknowledgePlayerDigging;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerBlockChange;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerChunkData;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerChunkDataBulk;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerMultiBlockChange;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerUnloadChunk;
import it.unimi.dsi.fastutil.ints.IntArrayList;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Polaris's anti-xray: every ore no player could see is sent to them as the rock
 * around it, so an X-Ray client has nothing to show.
 *
 * - Chunks: an ore whose six faces all touch opaque, full blocks is sent as
 *   stone, deepslate or netherrack. Sections whose palette holds no ore are not
 *   read at all.
 * - Every block update the server sends afterwards goes through the same filter,
 *   so asking the server about a position (the trick that defeats most
 *   anti-xrays: "stop digging" at a guessed position, and the server answers with
 *   the real block) gets rock back while the ore is still buried.
 * - When a block next to buried ore turns into something see-through - mined,
 *   exploded, flooded - the ore within two blocks is sent for real, before the
 *   player can see it.
 * - An ore at the edge of a chunk is checked against the neighbouring chunk once
 *   the client has both, and shown if that side is open.
 * - Polaris's honeypots are never hidden: with everything else hidden, they are
 *   the only buried ore an X-Ray client still shows.
 *
 * Runs after the world replica has read each packet, so the anti-cheat keeps
 * checking against the real world; a buried ore and the rock sent instead are
 * both full blocks, so movement is predicted the same either way.
 */
public final class AntiXray extends PacketListenerAbstract {
    /** Positions within two blocks (Manhattan distance), nearest first. */
    private static final int[][] AROUND = around(2);

    private static volatile AntiXray running;

    private final AntiXrayBlocks blocks;

    public AntiXray() {
        super(PacketListenerPriority.HIGHEST);
        this.blocks = new AntiXrayBlocks(CompensatedWorld.blockVersion);
    }

    /**
     * Whether this server wants it: on unless Polaris switched it off. Never on
     * NeoForge, where the Polaris mod the engine ships inside hides ore itself.
     */
    public static boolean wanted() {
        if (PolarisAPI.INSTANCE.getPlatform() == Platform.NEOFORGE) return false;
        String value = System.getenv("POLARIS_ANTIXRAY");
        return value == null || !value.trim().toLowerCase(Locale.ROOT).equals("off");
    }

    public static AntiXray start() {
        AntiXray engine = new AntiXray();
        running = engine;
        return engine;
    }

    /** The running engine, or null when it is off. */
    public static AntiXray running() {
        return running;
    }

    public AntiXrayBlocks blocks() {
        return blocks;
    }

    @Override
    public void onPacketSend(PacketSendEvent event) {
        PacketTypeCommon type = event.getPacketType();
        if (type != PacketType.Play.Server.CHUNK_DATA
                && type != PacketType.Play.Server.MAP_CHUNK_BULK
                && type != PacketType.Play.Server.BLOCK_CHANGE
                && type != PacketType.Play.Server.MULTI_BLOCK_CHANGE
                && type != PacketType.Play.Server.ACKNOWLEDGE_PLAYER_DIGGING
                && type != PacketType.Play.Server.UNLOAD_CHUNK
                && type != PacketType.Play.Server.JOIN_GAME
                && type != PacketType.Play.Server.RESPAWN) {
            return;
        }
        PolarisPlayer player = PolarisAPI.INSTANCE.getPlayerDataManager().getPlayer(event.getUser());
        if (player == null) return;

        if (type == PacketType.Play.Server.JOIN_GAME || type == PacketType.Play.Server.RESPAWN) {
            player.antiXray.reset(player.user.getMinWorldHeight());
        } else if (type == PacketType.Play.Server.UNLOAD_CHUNK) {
            WrapperPlayServerUnloadChunk unload = new WrapperPlayServerUnloadChunk(event);
            player.antiXray.unload(unload.getChunkX(), unload.getChunkZ());
        } else if (type == PacketType.Play.Server.CHUNK_DATA) {
            WrapperPlayServerChunkData packet = new WrapperPlayServerChunkData(event);
            Column column = packet.getColumn();
            if (column == null) return;
            if (hideIn(player, column.getX(), column.getZ(), column.getChunks(), column.isFullChunk())) {
                event.markForReEncode(true);
            }
            checkBordersLater(player, event, column.getX(), column.getZ());
        } else if (type == PacketType.Play.Server.MAP_CHUNK_BULK) {
            WrapperPlayServerChunkDataBulk packet = new WrapperPlayServerChunkDataBulk(event);
            boolean changed = false;
            for (int i = 0; i < packet.getChunks().length; i++) {
                changed |= hideIn(player, packet.getX()[i], packet.getZ()[i], packet.getChunks()[i], true);
                checkBordersLater(player, event, packet.getX()[i], packet.getZ()[i]);
            }
            if (changed) event.markForReEncode(true);
        } else {
            filterUpdate(player, event, type);
        }
    }

    /**
     * Send every buried ore of a chunk as rock. Returns whether anything changed.
     */
    boolean hideIn(PolarisPlayer player, int chunkX, int chunkZ, BaseChunk[] sections, boolean full) {
        AntiXrayView view = player.antiXray;
        int minY = player.user.getMinWorldHeight();
        if (view.minY() != minY) view.reset(minY);

        long key = AntiXrayView.chunkKey(chunkX, chunkZ);
        var map = full ? view.startChunk(key) : view.startSections(key, present(sections));
        int dimension = trapDimension(player);
        boolean changed = false;

        for (int s = 0; s < sections.length; s++) {
            BaseChunk section = sections[s];
            if (section == null || section.isEmpty() || !mayHold(section)) continue;
            for (int y = 0; y < 16; y++) {
                for (int z = 0; z < 16; z++) {
                    for (int x = 0; x < 16; x++) {
                        int id = section.getBlockId(x, y, z);
                        if (!blocks.isHidden(id) || isOpen(sections, s, x, y, z)) continue;
                        int worldY = minY + (s << 4) + y;
                        if (dimension >= 0 && PolarisTraps.isTrap(dimension, (chunkX << 4) + x, worldY, (chunkZ << 4) + z)) {
                            continue;
                        }
                        map.put((((s << 4) | y) << 8) | (z << 4) | x, id);
                        section.set(x, y, z, blocks.fakeOf(id));
                        changed = true;
                    }
                }
            }
        }
        return changed;
    }

    private static boolean[] present(BaseChunk[] sections) {
        boolean[] present = new boolean[sections.length];
        for (int i = 0; i < sections.length; i++) present[i] = sections[i] != null;
        return present;
    }

    /** Whether a section can hold ore at all, from its palette where it has one. */
    private boolean mayHold(BaseChunk section) {
        if (!(section instanceof Chunk_v1_18 modern) || modern.getChunkData() == null) return true;
        Palette palette = modern.getChunkData().palette;
        if (palette == null || palette instanceof GlobalPalette) return true;
        for (int i = 0; i < palette.size(); i++) {
            if (blocks.isHidden(palette.idToState(i))) return true;
        }
        return false;
    }

    /**
     * Whether any face of a block in this chunk shows: a neighbour that is not
     * opaque, or the outside of the world. A neighbour in another chunk counts as
     * covering here; checkBorders looks at it once the client has that chunk.
     */
    private boolean isOpen(BaseChunk[] sections, int s, int x, int y, int z) {
        int column = (s << 4) + y;
        return isOpenAt(sections, x, column + 1, z)
                || isOpenAt(sections, x, column - 1, z)
                || (x < 15 && isOpenAt(sections, x + 1, column, z))
                || (x > 0 && isOpenAt(sections, x - 1, column, z))
                || (z < 15 && isOpenAt(sections, x, column, z + 1))
                || (z > 0 && isOpenAt(sections, x, column, z - 1));
    }

    private boolean isOpenAt(BaseChunk[] sections, int x, int column, int z) {
        if (column < 0 || column >= sections.length << 4) return true;
        BaseChunk section = sections[column >> 4];
        return section == null || !blocks.isOccluding(section.getBlockId(x, column & 15, z));
    }

    /** Which of Polaris's honeypot lists applies to the player's dimension, or -1. */
    private static int trapDimension(PolarisPlayer player) {
        try {
            DimensionType type = player.user.getDimensionType();
            if (type == null) return PolarisTraps.OVERWORLD;
            if (type.isUltraWarm()) return PolarisTraps.NETHER;
            return type.isNatural() && !type.hasCeiling() ? PolarisTraps.OVERWORLD : -1;
        } catch (RuntimeException unknown) {
            return PolarisTraps.OVERWORLD;
        }
    }

    // ---- Block updates -----------------------------------------------------------

    private void filterUpdate(PolarisPlayer player, PacketSendEvent event, PacketTypeCommon type) {
        IntArrayList reveals = new IntArrayList();
        if (type == PacketType.Play.Server.BLOCK_CHANGE) {
            WrapperPlayServerBlockChange packet = new WrapperPlayServerBlockChange(event);
            Vector3i at = packet.getBlockPosition();
            int sent = filter(player.antiXray, at.x, at.y, at.z, packet.getBlockId(), reveals);
            if (sent != packet.getBlockId()) {
                packet.setBlockID(sent);
                event.markForReEncode(true);
            }
        } else if (type == PacketType.Play.Server.MULTI_BLOCK_CHANGE) {
            WrapperPlayServerMultiBlockChange packet = new WrapperPlayServerMultiBlockChange(event);
            WrapperPlayServerMultiBlockChange.EncodedBlock[] changes = packet.getBlocks();
            WrapperPlayServerMultiBlockChange.EncodedBlock[] rewritten = null;
            for (int i = 0; i < changes.length; i++) {
                WrapperPlayServerMultiBlockChange.EncodedBlock change = changes[i];
                int sent = filter(player.antiXray, change.getX(), change.getY(), change.getZ(), change.getBlockId(), reveals);
                if (sent == change.getBlockId()) continue;
                // A new array: the world replica keeps the one it read, with the real blocks.
                if (rewritten == null) rewritten = changes.clone();
                rewritten[i] = new WrapperPlayServerMultiBlockChange.EncodedBlock(sent, change.getX(), change.getY(), change.getZ());
            }
            if (rewritten != null) {
                packet.setBlocks(rewritten);
                event.markForReEncode(true);
            }
        } else {
            WrapperPlayServerAcknowledgePlayerDigging packet = new WrapperPlayServerAcknowledgePlayerDigging(event);
            Vector3i at = packet.getBlockPosition();
            int sent = filter(player.antiXray, at.x, at.y, at.z, packet.getBlockId(), reveals);
            if (sent != packet.getBlockId()) {
                packet.setBlockId(sent);
                event.markForReEncode(true);
            }
        }
        if (!reveals.isEmpty()) {
            event.getTasksAfterSend().add(() -> send(player, reveals));
        }
    }

    /**
     * What the client is sent for one block the server changed: rock for a
     * position that is still buried, the block itself for anything else. A change
     * that opens a position up queues the buried ore around it to be shown.
     */
    int filter(AntiXrayView view, int x, int y, int z, int id, IntArrayList reveals) {
        if (y < view.minY() || !view.isTracked(x >> 4, z >> 4)) return id;
        if (!view.isRevealed(x, y, z) && view.realAt(x, y, z) >= 0) {
            if (blocks.isHidden(id)) {
                view.hide(x, y, z, id);
                return blocks.fakeOf(id);
            }
            view.forget(x, y, z);
        }
        if (!blocks.isOccluding(id)) revealAround(view, x, y, z, reveals);
        return id;
    }

    private static void revealAround(AntiXrayView view, int x, int y, int z, IntArrayList reveals) {
        for (int[] offset : AROUND) {
            int rx = x + offset[0];
            int ry = y + offset[1];
            int rz = z + offset[2];
            if (ry < view.minY()) continue;
            int real = view.reveal(rx, ry, rz);
            if (real >= 0) {
                reveals.add(rx);
                reveals.add(ry);
                reveals.add(rz);
                reveals.add(real);
            }
        }
    }

    private static void send(PolarisPlayer player, IntArrayList reveals) {
        for (int i = 0; i + 3 < reveals.size(); i += 4) {
            player.user.sendPacket(new WrapperPlayServerBlockChange(
                    new Vector3i(reveals.getInt(i), reveals.getInt(i + 1), reveals.getInt(i + 2)), reveals.getInt(i + 3)));
        }
    }

    // ---- Chunk borders -----------------------------------------------------------

    /**
     * Once the client has confirmed a chunk, the replica holds it and every chunk
     * sent before it: check the ores on its edges, and on the edges of its
     * neighbours that face it, against the other side.
     *
     * When the client is already up to date the check runs at once, while the
     * chunk itself is still being sent: what it shows then goes out after the
     * chunk, or the chunk would arrive second and bury it again.
     */
    private void checkBordersLater(PolarisPlayer player, PacketSendEvent event, int chunkX, int chunkZ) {
        boolean[] sending = {true};
        player.latencyUtils.addRealTimeTask(player.lastTransactionSent.get(), () -> {
            IntArrayList reveals = new IntArrayList();
            checkBorders(player, chunkX, chunkZ, reveals);
            checkBorders(player, chunkX - 1, chunkZ, reveals);
            checkBorders(player, chunkX + 1, chunkZ, reveals);
            checkBorders(player, chunkX, chunkZ - 1, reveals);
            checkBorders(player, chunkX, chunkZ + 1, reveals);
            if (reveals.isEmpty()) return;
            if (sending[0]) event.getTasksAfterSend().add(() -> send(player, reveals));
            else send(player, reveals);
        });
        sending[0] = false;
    }

    private void checkBorders(PolarisPlayer player, int chunkX, int chunkZ, IntArrayList reveals) {
        AntiXrayView view = player.antiXray;
        if (!view.isTracked(chunkX, chunkZ)) return;
        List<int[]> open = new ArrayList<>();
        view.forEachHidden(chunkX, chunkZ, index -> {
            int x = index & 15;
            int z = (index >> 4) & 15;
            if (x != 0 && x != 15 && z != 0 && z != 15) return;
            int worldX = (chunkX << 4) + x;
            int worldZ = (chunkZ << 4) + z;
            int y = view.yOf(index);
            if ((x == 0 && isOpenOutside(player, worldX - 1, y, worldZ))
                    || (x == 15 && isOpenOutside(player, worldX + 1, y, worldZ))
                    || (z == 0 && isOpenOutside(player, worldX, y, worldZ - 1))
                    || (z == 15 && isOpenOutside(player, worldX, y, worldZ + 1))) {
                open.add(new int[]{worldX, y, worldZ});
            }
        });
        for (int[] at : open) {
            int real = view.reveal(at[0], at[1], at[2]);
            if (real < 0) continue;
            reveals.add(at[0]);
            reveals.add(at[1]);
            reveals.add(at[2]);
            reveals.add(real);
        }
    }

    /** A block in a neighbouring chunk, as the client has it; unknown counts as covering. */
    private boolean isOpenOutside(PolarisPlayer player, int x, int y, int z) {
        if (!player.antiXray.isTracked(x >> 4, z >> 4)) return false;
        int id = player.compensatedWorld.getBlockStateId(x, y, z);
        if (id == -2 || id == -1) return false; // chunk not in the replica yet, or below the world
        return id < 0 || !blocks.isOccluding(id); // -3: an empty section
    }

    private static int[][] around(int radius) {
        List<int[]> offsets = new ArrayList<>();
        for (int distance = 1; distance <= radius; distance++) {
            for (int dx = -distance; dx <= distance; dx++) {
                for (int dy = -distance; dy <= distance; dy++) {
                    for (int dz = -distance; dz <= distance; dz++) {
                        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) == distance) offsets.add(new int[]{dx, dy, dz});
                    }
                }
            }
        }
        return offsets.toArray(new int[0][]);
    }
}
