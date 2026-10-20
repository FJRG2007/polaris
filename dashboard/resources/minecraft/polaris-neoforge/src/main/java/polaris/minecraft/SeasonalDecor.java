package polaris.minecraft;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.network.protocol.game.ClientboundAddEntityPacket;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundRemoveEntitiesPacket;
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket;
import net.minecraft.network.protocol.game.ClientboundSetHeldSlotPacket;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.Display;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.SnowyDirtBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.event.level.ChunkWatchEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import polaris.minecraft.mixin.BlockDisplayInvoker;

/**
 * The season Polaris says it is, drawn on each player's screen and nowhere else.
 *
 * The dashboard decides the season from its own calendar and says so with
 * {@code polaris season set <halloween|winter> <seconds>} (kept that long, and
 * told again while it lasts) or {@code polaris season clear}. This jar keeps no
 * dates of its own.
 *
 * Everything is sent as block updates to one player's game, never set in the
 * world: nothing reaches a region file, and a chunk the game loads again shows
 * the world as it is. Pumpkins take the place of a grass block in the ground (the
 * same full block underfoot, so nobody walks into one); cobwebs hang under the
 * leaves of a natural tree, at least three blocks clear of the ground, drawn as a
 * block display only that player's game has ({@link #show}). A web block slowed
 * whoever passed through it on their screen while the server, which holds air
 * there, did not, so it had to vanish before they reached it; a display has
 * nothing to walk into and stays in sight up close. In winter
 * a thin layer of snow, which nothing collides with, lies on some grass and snow
 * falls around a player standing under the open sky. Only on ground whose every
 * neighbour is natural - a block anybody placed nearby, a path, a fence, keeps
 * the spot bare - and only on leaves the game grew (a player's are persistent).
 * Nothing near what an event batch built ({@link #avoid}).
 *
 * Sparse and the same each time: every chunk is decided from the world's seed
 * and its coordinates alone, so a pumpkin never moves. A few chunks around each
 * player are decided per second, within a budget. A chunk sent to a player's
 * game again (which wipes what it was shown there) gets its decorations back
 * straight after it, and what was sent is sent again now and then - a block
 * that changed since loses it.
 *
 * A decoration a player breaks comes down for everybody and stays down for the
 * rest of the season ({@link BrokenDecor}, kept beside the world). Every hit on
 * one is called off, so the real block under it - the grass under a pumpkin,
 * the leaves under a light - is neither broken nor dropped. Left to the game,
 * the hit broke that real block instead (a hole, and dirt), or nothing at all
 * where the decoration stood in air, and the next time the chunk was decided
 * the decoration stood there again. A pumpkin takes as long to dig as a real
 * one and drops itself ({@link #onHit}); anything else comes down on the first
 * hit. Pick block on one gives the decoration, not the real block under it
 * ({@link #pick}).
 *
 * Server thread only: the commands and the tick both run there.
 */
public final class SeasonalDecor {
    enum Season {
        HALLOWEEN(0x5EA50171L), WINTER(0x5EA50172L);

        final long salt;

        Season(long salt) {
            this.salt = salt;
        }

        static Season named(String name) {
            return switch (name) {
                case "halloween" -> HALLOWEEN;
                case "winter" -> WINTER;
                default -> null;
            };
        }
    }

    /** How far round a player decorations reach, in chunks. */
    private static final int RADIUS = 3;
    /** Past this, a chunk the player left is forgotten: their game has let it go. */
    private static final int FORGET = 12;
    /** New chunks decided per player per pass, and for everybody together. */
    private static final int NEW_PER_PLAYER = 4;
    private static final int NEW_PER_PASS = 16;
    private static final int PASS_TICKS = 20;
    private static final int RESEND_TICKS = 600;
    /** How often the decorations knocked down since the last write are written, so a
     *  player breaking a row of them costs one write instead of one each. */
    private static final int FLUSH_TICKS = 200;
    private static final int SNOW_TICKS = 5;
    private static final int ASH_TICKS = 40;
    /** Room kept round what an event built. */
    private static final int AVOID_PAD = 16;
    private static final int AVOID_KEPT = 64;
    private static final long MAX_HOLD_SECONDS = 24 * 60 * 60;
    /** Halloween chunks with a pumpkin, and of those, the ones with two, in percent. */
    private static final int PUMPKIN_CHUNKS = 45;
    private static final int TWO_PUMPKIN_CHUNKS = 30;
    /** Where the decorations players knocked down are kept, beside the world. */
    private static final String BROKEN_FILE = "polaris-season-broken.json";

    /**
     * One block a player's game was told is something else, and what it really
     * was - or, for a cobweb, the display drawn there instead. The display is
     * never added to the world: it only lends its id and its data to the packets.
     */
    private record Fake(BlockPos pos, BlockState real, BlockState shown, Display.BlockDisplay display) {
        Fake(BlockPos pos, BlockState real, BlockState shown) {
            this(pos, real, shown, null);
        }
    }

    private static final class Seen {
        ResourceKey<Level> dimension;
        final Map<Long, List<Fake>> chunks = new HashMap<>();
    }

    private static Season season;
    /** Whether the dashboard has said anything since this jar started. */
    private static boolean told;
    private static long untilMillis;
    private static final Map<UUID, Seen> seen = new HashMap<>();
    /** {minX, minZ, maxX, maxZ}, padded, oldest first. */
    private static final ArrayDeque<long[]> avoided = new ArrayDeque<>();
    private static int ticks;
    private static BrokenDecor broken = new BrokenDecor();
    private static Path brokenFile;
    /** Knocked down since the list was last written. */
    private static boolean brokenDirty;

    /** A pumpkin a player is digging: where, the tick they started, and how much of it each tick takes. */
    private record Dig(BlockPos pos, long since, float perTick) {}

    private static final Map<UUID, Dig> digs = new HashMap<>();
    /** How much of a block a dig must have taken when the player's game says it is done, as the game's own check. */
    private static final float DUG = 0.7f;

    // ------------------------------------------------------------------ commands

    /** {@code polaris season set <name> <seconds> [<spawns%> <golems%>]}: the mob
     *  settings are {@link SeasonalMobs}'. */
    static JsonObject set(MinecraftServer server, String name, long seconds, int spawns, int golems) {
        Season next = Season.named(name);
        if (next == null) return refused("unknownSeason");
        if (next != season) {
            revertAll(server);
            SeasonalMobs.revert(server);
        }
        season = next;
        told = true;
        keepBroken(server, next);
        untilMillis = System.currentTimeMillis() + Math.min(Math.max(seconds, 1), MAX_HOLD_SECONDS) * 1000L;
        SeasonalMobs.configure(server, spawns, golems);
        return status();
    }

    /** {@code polaris season clear}. */
    static JsonObject clear(MinecraftServer server) {
        if (season != null) revertAll(server);
        flushBroken();
        season = null;
        told = true;
        SeasonalMobs.revert(server);
        return status();
    }

    /** The season showing now, or null. */
    static Season season() {
        return season;
    }

    /** Whether a season or a clear has been said since start: a null season is only known to be none then. */
    static boolean told() {
        return told;
    }

    /** {@code polaris season status}. */
    static JsonObject status() {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("season", season == null ? "" : season.name().toLowerCase(Locale.ROOT));
        reply.addProperty("untilMillis", season == null ? 0 : untilMillis);
        int blocks = 0;
        for (Seen one : seen.values()) for (List<Fake> fakes : one.chunks.values()) blocks += fakes.size();
        reply.addProperty("players", seen.size());
        reply.addProperty("blocks", blocks);
        reply.addProperty("broken", broken.size());
        SeasonalMobs.status(reply);
        return reply;
    }

    private static JsonObject refused(String why) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", false);
        reply.addProperty("why", why);
        return reply;
    }

    /**
     * Keep decorations away from what an event is building: every chunk within
     * {@link #AVOID_PAD} blocks of the box, for as long as the server runs. What
     * a player was already shown there is put back first.
     */
    static void avoid(MinecraftServer server, long minX, long minZ, long maxX, long maxZ) {
        long[] box = {minX - AVOID_PAD, minZ - AVOID_PAD, maxX + AVOID_PAD, maxZ + AVOID_PAD};
        avoided.addLast(box);
        while (avoided.size() > AVOID_KEPT) avoided.removeFirst();
        if (seen.isEmpty()) return;
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            Seen one = seen.get(player.getUUID());
            if (one == null) continue;
            for (Map.Entry<Long, List<Fake>> chunk : one.chunks.entrySet()) {
                ChunkPos pos = new ChunkPos(chunk.getKey());
                if (!overlaps(box, pos.x, pos.z)) continue;
                for (Fake fake : chunk.getValue()) restore(player, fake);
                chunk.setValue(List.of());
            }
        }
    }

    private static boolean overlaps(long[] box, int chunkX, int chunkZ) {
        long x0 = (long) chunkX << 4;
        long z0 = (long) chunkZ << 4;
        return x0 + 15 >= box[0] && x0 <= box[2] && z0 + 15 >= box[1] && z0 <= box[3];
    }

    /** Everything a player was shown taken down, to be decided again on the next pass. */
    static void redraw(MinecraftServer server) {
        revertAll(server);
    }

    static boolean isAvoided(int chunkX, int chunkZ) {
        for (long[] box : avoided) if (overlaps(box, chunkX, chunkZ)) return true;
        return false;
    }

    // ------------------------------------------------------------------ the tick

    @SubscribeEvent
    public void onTick(ServerTickEvent.Post event) {
        if (season == null) return;
        MinecraftServer server = event.getServer();
        try {
            if (System.currentTimeMillis() > untilMillis) {
                clear(server);
                return;
            }
            ticks++;
            if (season == Season.WINTER && ticks % SNOW_TICKS == 0) particles(server, true);
            if (season == Season.HALLOWEEN && ticks % ASH_TICKS == 0) particles(server, false);
            if (ticks % PASS_TICKS == 0) pass(server, ticks % RESEND_TICKS == 0);
            if (ticks % FLUSH_TICKS == 0) flushBroken();
        } catch (RuntimeException failed) {
            // A tick must never fail over a decoration: put everything back and stop.
            PolarisMod.LOG.error("Polaris seasonal decorations failed and are off until told again", failed);
            try {
                clear(server);
            } catch (RuntimeException ignored) {
                season = null;
                seen.clear();
                SeasonalMobs.forget();
            }
        }
    }

    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        flushBroken();
    }

    @SubscribeEvent
    public void onLeave(PlayerEvent.PlayerLoggedOutEvent event) {
        seen.remove(event.getEntity().getUUID());
        digs.remove(event.getEntity().getUUID());
    }

    private static void pass(MinecraftServer server, boolean resend) {
        int budget = NEW_PER_PASS;
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            Seen one = seen.computeIfAbsent(player.getUUID(), id -> new Seen());
            ServerLevel level = player.serverLevel();
            // A game that changed dimension dropped every chunk it had.
            if (one.dimension != level.dimension()) {
                one.chunks.clear();
                one.dimension = level.dimension();
            }
            if (level.dimension() != Level.OVERWORLD) continue;
            ChunkPos at = player.chunkPosition();
            one.chunks.entrySet().removeIf(chunk -> {
                ChunkPos pos = new ChunkPos(chunk.getKey());
                if (Math.abs(pos.x - at.x) <= FORGET && Math.abs(pos.z - at.z) <= FORGET) return false;
                // Their game let the blocks go with the chunk; a display it keeps until told.
                for (Fake fake : chunk.getValue()) if (fake.display() != null) restore(player, fake);
                return true;
            });
            if (resend) resend(player, level, one, at);
            budget -= decorateAround(player, level, one, at, Math.min(budget, NEW_PER_PLAYER));
            if (budget <= 0 && !resend) break;
        }
    }

    /** Decide the chunks round a player not yet decided, nearest first. */
    private static int decorateAround(ServerPlayer player, ServerLevel level, Seen one, ChunkPos at, int budget) {
        int done = 0;
        for (int ring = 0; ring <= RADIUS && done < budget; ring++) {
            for (int dx = -ring; dx <= ring && done < budget; dx++) {
                for (int dz = -ring; dz <= ring && done < budget; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) != ring) continue;
                    int cx = at.x + dx;
                    int cz = at.z + dz;
                    long key = ChunkPos.asLong(cx, cz);
                    if (one.chunks.containsKey(key) || !level.hasChunk(cx, cz)) continue;
                    List<Fake> fakes = isAvoided(cx, cz) ? List.of() : decide(level, cx, cz, season);
                    one.chunks.put(key, fakes);
                    for (Fake fake : fakes) show(player, fake);
                    done++;
                }
            }
        }
        return done;
    }

    /** Send again what is still true, and put back what changed underneath. */
    private static void resend(ServerPlayer player, ServerLevel level, Seen one, ChunkPos at) {
        for (Map.Entry<Long, List<Fake>> chunk : one.chunks.entrySet()) {
            ChunkPos pos = new ChunkPos(chunk.getKey());
            if (Math.abs(pos.x - at.x) > RADIUS || Math.abs(pos.z - at.z) > RADIUS) continue;
            if (chunk.getValue().isEmpty() || !level.hasChunk(pos.x, pos.z)) continue;
            chunk.setValue(showStill(player, level, chunk.getValue()));
        }
    }

    private static void revertAll(MinecraftServer server) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            Seen one = seen.get(player.getUUID());
            if (one == null || one.dimension != player.serverLevel().dimension()) continue;
            for (List<Fake> fakes : one.chunks.values()) for (Fake fake : fakes) restore(player, fake);
        }
        seen.clear();
        digs.clear();
    }

    /**
     * A player hit a decoration they are shown: it comes down for everybody and
     * is remembered as broken for the rest of the season. Thin snow takes the
     * snowy look of the ground under it along. Returns what was shown there, or
     * null when nothing was - and for a real block only drawn differently (the
     * snowy grass), which the player is digging and is left to the game.
     */
    static BlockState takeDown(ServerPlayer player, BlockPos pos) {
        Fake hit = shownAt(player, pos);
        if (hit == null) return null;
        Seen one = seen.get(player.getUUID());
        if (broken.add(pos.asLong())) brokenDirty = true;
        BlockPos under = hit.shown().is(Blocks.SNOW) ? pos.below() : null;
        for (ServerPlayer other : player.serverLevel().getServer().getPlayerList().getPlayers()) {
            Seen theirs = seen.get(other.getUUID());
            if (theirs == null || theirs.dimension != one.dimension) continue;
            drop(other, theirs, pos);
            if (under != null) drop(other, theirs, under);
        }
        return hit.shown();
    }

    /** The decoration a player is shown at a block, or null - and null for a real block only drawn differently. */
    private static Fake shownAt(ServerPlayer player, BlockPos pos) {
        Seen one = seen.get(player.getUUID());
        if (one == null || one.dimension != player.serverLevel().dimension()) return null;
        List<Fake> fakes = one.chunks.get(ChunkPos.asLong(pos.getX() >> 4, pos.getZ() >> 4));
        if (fakes == null) return null;
        Fake hit = null;
        for (Fake fake : fakes) if (fake.pos().equals(pos)) hit = fake;
        return hit == null || redrawn(hit) ? null : hit;
    }

    /** A real block only drawn in another state of itself, as grass drawn snowy. */
    private static boolean redrawn(Fake fake) {
        return fake.shown().is(fake.real().getBlock());
    }

    private static void drop(ServerPlayer player, Seen one, BlockPos pos) {
        long key = ChunkPos.asLong(pos.getX() >> 4, pos.getZ() >> 4);
        List<Fake> fakes = one.chunks.get(key);
        if (fakes == null) return;
        List<Fake> kept = new ArrayList<>(fakes.size());
        for (Fake fake : fakes) {
            if (fake.pos().equals(pos)) restore(player, fake);
            else kept.add(fake);
        }
        if (kept.size() != fakes.size()) one.chunks.put(key, kept);
    }

    /**
     * Every hit on a decoration is called off, so the real block under it stays
     * as it is and drops nothing. Before the game's own checks: a decoration
     * standing in air never reaches them at all.
     *
     * A pumpkin is dug like a real one: the player's game digs what it is shown
     * and says when it is done, and it comes down then - dropping itself, and
     * only once as much time has gone as the game would have taken
     * ({@link #DUG}, from the tool, enchantments and effects in hand). One dug
     * in a single hit, or hit by a player in creative, comes down on that hit.
     * Anything else comes down on the first hit, as before: nobody digs a web
     * or a light out of leaves they cannot reach.
     */
    @SubscribeEvent
    public void onHit(PlayerInteractEvent.LeftClickBlock event) {
        if (season == null || !(event.getEntity() instanceof ServerPlayer player)) return;
        PlayerInteractEvent.LeftClickBlock.Action action = event.getAction();
        if (action == PlayerInteractEvent.LeftClickBlock.Action.CLIENT_HOLD) return;
        BlockPos pos = event.getPos();
        Fake hit = shownAt(player, pos);
        if (hit == null) return;
        event.setCanceled(true);
        BlockState shown = hit.shown();
        if (!pumpkin(shown) || player.isCreative()) {
            if (action == PlayerInteractEvent.LeftClickBlock.Action.START) knockDown(player, pos, shown, !player.isCreative());
            return;
        }
        long now = player.serverLevel().getGameTime();
        switch (action) {
            case START -> {
                float perTick = shown.getDestroyProgress(player, player.serverLevel(), pos);
                if (perTick >= 1) knockDown(player, pos, shown, true);
                else digs.put(player.getUUID(), new Dig(pos, now, perTick));
            }
            case STOP -> {
                Dig dig = digs.remove(player.getUUID());
                if (dig != null && dig.pos().equals(pos) && (now - dig.since() + 1) * dig.perTick() >= DUG) {
                    knockDown(player, pos, shown, true);
                } else {
                    // Too soon: their game took it out already, so it is shown again.
                    show(player, hit);
                }
            }
            case ABORT -> {
                Dig dig = digs.get(player.getUUID());
                if (dig != null && dig.pos().equals(pos)) digs.remove(player.getUUID());
            }
            default -> {}
        }
    }

    /** Down for everybody; a pumpkin dug out drops itself, and may be a trap. */
    private static void knockDown(ServerPlayer player, BlockPos pos, BlockState shown, boolean dug) {
        if (takeDown(player, pos) == null || !pumpkin(shown)) return;
        if (dug) Block.popResourceFromFace(player.serverLevel(), pos, Direction.UP, new ItemStack(shown.getBlock()));
        SeasonalHalloween.trap(player, player.serverLevel(), pos);
    }

    /** A chunk sent to a player's game again wiped what it was shown there: show it again, after it. */
    @SubscribeEvent
    public void onChunkSent(ChunkWatchEvent.Sent event) {
        if (season == null) return;
        ServerPlayer player = event.getPlayer();
        Seen one = seen.get(player.getUUID());
        if (one == null || one.dimension != event.getLevel().dimension()) return;
        long key = event.getPos().toLong();
        List<Fake> fakes = one.chunks.get(key);
        if (fakes == null || fakes.isEmpty()) return;
        one.chunks.put(key, showStill(player, event.getLevel(), fakes));
    }

    /** Show again what is still true, and put back what changed underneath; what is still shown. */
    private static List<Fake> showStill(ServerPlayer player, ServerLevel level, List<Fake> fakes) {
        List<Fake> kept = new ArrayList<>(fakes.size());
        for (Fake fake : fakes) {
            if (level.getBlockState(fake.pos()) == fake.real()) {
                show(player, fake);
                kept.add(fake);
            } else {
                restore(player, fake);
            }
        }
        return kept;
    }

    /** The broken list for this season, read from beside the world the first time. */
    private static void keepBroken(MinecraftServer server, Season next) {
        if (brokenFile == null) {
            brokenFile = server.getWorldPath(LevelResource.ROOT).resolve(BROKEN_FILE);
            try {
                broken = BrokenDecor.read(brokenFile);
            } catch (IOException unreadable) {
                PolarisMod.LOG.warn("Polaris could not read {}; decorations broken before come back", brokenFile, unreadable);
            }
        }
        if (broken.keepFor(next.name().toLowerCase(Locale.ROOT), System.currentTimeMillis())) writeBroken();
    }

    private static void flushBroken() {
        if (brokenDirty) writeBroken();
    }

    private static void writeBroken() {
        brokenDirty = false;
        if (brokenFile == null) return;
        try {
            broken.write(brokenFile);
        } catch (IOException failed) {
            PolarisMod.LOG.warn("Polaris could not write {}", brokenFile, failed);
        }
    }

    /** Whether a decoration was knocked down: itself, or the ground drawn snowy under thin snow that was. */
    private static boolean wasBroken(Fake fake) {
        if (broken.contains(fake.pos().asLong())) return true;
        return redrawn(fake) && broken.contains(fake.pos().above().asLong());
    }
    private static boolean pumpkin(BlockState state) {
        return state.is(Blocks.PUMPKIN) || state.is(Blocks.CARVED_PUMPKIN) || state.is(Blocks.JACK_O_LANTERN);
    }

    /**
     * Draw a decoration on one player's screen: a block update, or for a cobweb
     * its display. A display their game already has is replaced by the same one,
     * so this is safe to send again.
     */
    private static void show(ServerPlayer player, Fake fake) {
        Display.BlockDisplay display = fake.display();
        if (display == null) {
            player.connection.send(new ClientboundBlockUpdatePacket(fake.pos(), fake.shown()));
            return;
        }
        player.connection.send(new ClientboundAddEntityPacket(display, 0, fake.pos()));
        List<SynchedEntityData.DataValue<?>> data = display.getEntityData().getNonDefaultValues();
        if (data != null) player.connection.send(new ClientboundSetEntityDataPacket(display.getId(), data));
    }

    /** The block as it really is now, which is what the player's game shows after; a display is taken away. */
    private static void restore(ServerPlayer player, Fake fake) {
        if (fake.display() != null) player.connection.send(new ClientboundRemoveEntitiesPacket(fake.display().getId()));
        else player.connection.send(new ClientboundBlockUpdatePacket(player.serverLevel(), fake.pos()));
    }

    /** A cobweb as a block display: nothing collides with it, so nobody is slowed by a web the server does not have. */
    private static Display.BlockDisplay webDisplay(ServerLevel level) {
        Display.BlockDisplay display = new Display.BlockDisplay(EntityType.BLOCK_DISPLAY, level);
        ((BlockDisplayInvoker) display).polaris$setBlockState(Blocks.COBWEB.defaultBlockState());
        return display;
    }

    /**
     * Pick block (middle click), from the packet's handler on the server thread:
     * true when the player picked a decoration and it is answered here. The world
     * holds the grass under a pumpkin, so left to the game the pick gave that. A
     * cobweb is a display their game looks through, so its pick names the block
     * behind it; a web on the line of sight nearer than that block is what they
     * meant. Handed out as the game hands out a pick: selected where it already
     * is in the inventory, and in creative put in the hotbar when it is not.
     */
    public static boolean pick(ServerPlayer player, BlockPos pos) {
        if (season == null) return false;
        Fake hit = shownAt(player, pos);
        if (hit == null) hit = webInSight(player, pos);
        if (hit == null || !player.canInteractWithBlock(hit.pos(), 1.0)) return false;
        ItemStack item = new ItemStack(hit.shown().getBlock());
        if (item.isEmpty() || !item.isItemEnabled(player.level().enabledFeatures())) return true;
        Inventory inventory = player.getInventory();
        int slot = inventory.findSlotMatchingItem(item);
        if (slot != -1) {
            if (Inventory.isHotbarSlot(slot)) inventory.selected = slot;
            else inventory.pickSlot(slot);
        } else if (player.hasInfiniteMaterials()) {
            inventory.addAndPickItem(item);
        }
        player.connection.send(new ClientboundSetHeldSlotPacket(inventory.selected));
        player.inventoryMenu.broadcastChanges();
        return true;
    }

    /** The nearest cobweb a player is shown on their line of sight, before the block their game picked, or null. */
    private static Fake webInSight(ServerPlayer player, BlockPos picked) {
        Seen one = seen.get(player.getUUID());
        if (one == null || one.dimension != player.serverLevel().dimension()) return null;
        Vec3 eye = player.getEyePosition();
        Vec3 end = eye.add(player.getViewVector(1).scale(player.blockInteractionRange() + 1));
        double nearest = new AABB(picked).clip(eye, end).map(eye::distanceToSqr).orElse(Double.MAX_VALUE);
        ChunkPos at = player.chunkPosition();
        Fake web = null;
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                List<Fake> fakes = one.chunks.get(ChunkPos.asLong(at.x + dx, at.z + dz));
                if (fakes == null) continue;
                for (Fake fake : fakes) {
                    if (fake.display() == null) continue;
                    double distance = new AABB(fake.pos()).clip(eye, end).map(eye::distanceToSqr).orElse(Double.MAX_VALUE);
                    if (distance < nearest) {
                        nearest = distance;
                        web = fake;
                    }
                }
            }
        }
        return web;
    }

    private static void particles(MinecraftServer server, boolean snow) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            ServerLevel level = player.serverLevel();
            if (level.dimension() != Level.OVERWORLD || player.isSpectator()) continue;
            if (!level.canSeeSky(BlockPos.containing(player.getX(), player.getEyeY(), player.getZ()))) continue;
            if (snow) {
                level.sendParticles(player, ParticleTypes.SNOWFLAKE, false, false,
                        player.getX(), player.getY() + 6, player.getZ(), 6, 7, 2, 7, 0);
            } else if (level.isNight() && level.random.nextBoolean()) {
                level.sendParticles(player, ParticleTypes.WHITE_ASH, false, false,
                        player.getX(), player.getY() + 2, player.getZ(), 4, 6, 2, 6, 0);
            }
        }
    }

    // ------------------------------------------------------------------ deciding

    /** What a chunk shows this season: the same every time it is asked. */
    private static List<Fake> decide(ServerLevel level, int cx, int cz, Season season) {
        Random random = new Random(level.getSeed() ^ (ChunkPos.asLong(cx, cz) * 0x9E3779B97F4A7C15L) ^ season.salt);
        List<Fake> fakes = new ArrayList<>(4);
        int baseX = cx << 4;
        int baseZ = cz << 4;
        if (season == Season.HALLOWEEN) {
            // Most chunks get one, some two, and over half of them are lit: a
            // jack o'lantern is what a player sees from across a field at night.
            if (random.nextInt(100) < PUMPKIN_CHUNKS) {
                int pumpkins = random.nextInt(100) < TWO_PUMPKIN_CHUNKS ? 2 : 1;
                for (int tries = 0; tries < 8 && pumpkins > 0; tries++) {
                    BlockPos ground = groundAt(level, baseX + 2 + random.nextInt(12), baseZ + 2 + random.nextInt(12));
                    int kind = random.nextInt(100);
                    Direction facing = Direction.from2DDataValue(random.nextInt(4));
                    if (ground == null || !naturalGrass(level, ground) || taken(fakes, ground)) continue;
                    BlockState shown = kind < 55
                            ? Blocks.JACK_O_LANTERN.defaultBlockState().setValue(HorizontalDirectionalBlock.FACING, facing)
                            : kind < 85
                                    ? Blocks.CARVED_PUMPKIN.defaultBlockState().setValue(HorizontalDirectionalBlock.FACING, facing)
                                    : Blocks.PUMPKIN.defaultBlockState();
                    fakes.add(new Fake(ground, level.getBlockState(ground), shown));
                    pumpkins--;
                }
            }
            if (random.nextInt(100) < 35) {
                int webs = 1 + random.nextInt(2);
                for (int tries = 0; tries < 6 && webs > 0; tries++) {
                    BlockPos web = webUnder(level, baseX + random.nextInt(16), baseZ + random.nextInt(16));
                    if (web == null) continue;
                    fakes.add(new Fake(web, level.getBlockState(web), Blocks.COBWEB.defaultBlockState(), webDisplay(level)));
                    webs--;
                }
            }
        } else {
            if (random.nextInt(100) < 30) {
                int layers = 1 + random.nextInt(3);
                for (int tries = 0; tries < 6 && layers > 0; tries++) {
                    BlockPos ground = groundAt(level, baseX + 2 + random.nextInt(12), baseZ + 2 + random.nextInt(12));
                    if (ground == null || !naturalGrass(level, ground)) continue;
                    BlockState grass = level.getBlockState(ground);
                    BlockPos above = ground.above();
                    fakes.add(new Fake(above, level.getBlockState(above),
                            Blocks.SNOW.defaultBlockState().setValue(SnowLayerBlock.LAYERS, 1)));
                    if (grass.hasProperty(SnowyDirtBlock.SNOWY))
                        fakes.add(new Fake(ground, grass, grass.setValue(SnowyDirtBlock.SNOWY, true)));
                    layers--;
                }
            }
            // Christmas: more snow, and lights on the trees (SeasonalWinterDecor).
            SeasonalWinterDecor.decide(level, cx, cz, (pos, shown) -> fakes.add(new Fake(pos, level.getBlockState(pos), shown)));
        }
        fakes.removeIf(SeasonalDecor::wasBroken);
        return fakes;
    }

    /** Whether a pumpkin already stands within a few blocks of this one. */
    private static boolean taken(List<Fake> fakes, BlockPos ground) {
        for (Fake fake : fakes) if (fake.pos().distManhattan(ground) <= 4) return true;
        return false;
    }

    /** The top solid block of a column, ignoring leaves, or null outside the world. */
    static BlockPos groundAt(ServerLevel level, int x, int z) {
        int y = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
        return y <= level.getMinY() ? null : new BlockPos(x, y, z);
    }

    /**
     * A grass block with open air on it, on natural ground, in a 5x5 patch of
     * nothing but natural blocks from one below to one above it. A block anybody
     * placed - a path, a slab, a plank, a torch - rules the spot out.
     */
    static boolean naturalGrass(ServerLevel level, BlockPos ground) {
        if (!level.getBlockState(ground).is(Blocks.GRASS_BLOCK)) return false;
        if (!level.getBlockState(ground.above()).isAir()) return false;
        if (!level.getBlockState(ground.below()).is(BlockTags.DIRT)) return false;
        BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                for (int dy = -1; dy <= 1; dy++) {
                    at.set(ground.getX() + dx, ground.getY() + dy, ground.getZ() + dz);
                    if (!natural(level.getBlockState(at))) return false;
                }
            }
        }
        return true;
    }

    static boolean natural(BlockState state) {
        if (state.isAir()) return true;
        if (state.is(BlockTags.LEAVES)) return wild(state);
        return state.is(BlockTags.DIRT) || state.is(BlockTags.BASE_STONE_OVERWORLD) || state.is(BlockTags.SAND)
                || state.is(Blocks.GRAVEL) || state.is(BlockTags.FLOWERS) || state.is(BlockTags.REPLACEABLE);
    }

    /** Leaves the game grew: a player's are persistent. */
    static boolean wild(BlockState state) {
        return state.hasProperty(LeavesBlock.PERSISTENT) && !state.getValue(LeavesBlock.PERSISTENT);
    }

    /** Where a cobweb hangs under a natural tree's lowest leaves in this column, or null. */
    static BlockPos webUnder(ServerLevel level, int x, int z) {
        BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos(x,
                level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z) - 1, z);
        if (!wild(level.getBlockState(at))) return null;
        for (int down = 0; down < 8 && wild(level.getBlockState(at.below())); down++) at.move(Direction.DOWN);
        BlockPos web = at.below();
        // Three clear blocks under it: high over anybody's head, never in a path.
        for (int clear = 0; clear < 4; clear++) if (!level.getBlockState(web.below(clear)).isAir()) return null;
        return web.immutable();
    }
}
