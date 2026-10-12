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
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.SnowyDirtBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.event.level.ChunkWatchEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

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
 * leaves of a natural tree, at least three blocks clear of the ground, and a
 * player's game loses one before they can reach it ({@link #websNear}); in winter
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
 * A decoration a player hits comes down on that first hit, for everybody, and
 * stays down for the rest of the season ({@link BrokenDecor}, kept beside the
 * world): the hit is called off, so the real block under it - the grass under a
 * pumpkin, the leaves under a light - is neither broken nor dropped. Left to the
 * game, the hit broke that real block instead (a hole, and dirt), or nothing at
 * all where the decoration stood in air, and the next time the chunk was
 * decided the decoration stood there again.
 *
 * Server thread only: the commands and the tick both run there.
 */
final class SeasonalDecor {
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
    private static final int SNOW_TICKS = 5;
    private static final int ASH_TICKS = 40;
    /** Room kept round what an event built. */
    private static final int AVOID_PAD = 16;
    private static final int AVOID_KEPT = 64;
    private static final long MAX_HOLD_SECONDS = 24 * 60 * 60;
    /** How near a cobweb a player comes before their game loses it, in blocks, and
     *  how much further each block they moved in the last tick takes that. */
    private static final double WEB_REACH = 6;
    private static final double WEB_REACH_PER_SPEED = 12;
    /** Halloween chunks with a pumpkin, and of those, the ones with two, in percent. */
    private static final int PUMPKIN_CHUNKS = 45;
    private static final int TWO_PUMPKIN_CHUNKS = 30;
    /** Where the decorations players knocked down are kept, beside the world. */
    private static final String BROKEN_FILE = "polaris-season-broken.json";

    /** One block a player's game was told is something else, and what it really was. */
    private record Fake(BlockPos pos, BlockState real, BlockState shown) {}

    private static final class Seen {
        ResourceKey<Level> dimension;
        final Map<Long, List<Fake>> chunks = new HashMap<>();
        /** Where the player was on the last tick, for how fast they move. */
        Vec3 last;
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
            if (season == Season.HALLOWEEN) websNear(server);
            if (season == Season.WINTER && ticks % SNOW_TICKS == 0) particles(server, true);
            if (season == Season.HALLOWEEN && ticks % ASH_TICKS == 0) particles(server, false);
            if (ticks % PASS_TICKS == 0) pass(server, ticks % RESEND_TICKS == 0);
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
    public void onLeave(PlayerEvent.PlayerLoggedOutEvent event) {
        seen.remove(event.getEntity().getUUID());
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
            one.chunks.keySet().removeIf(key -> {
                ChunkPos pos = new ChunkPos(key);
                return Math.abs(pos.x - at.x) > FORGET || Math.abs(pos.z - at.z) > FORGET;
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
    }

    /**
     * A player hit a decoration they are shown: it comes down for everybody and
     * is remembered as broken for the rest of the season. Thin snow takes the
     * snowy look of the ground under it along. Returns what was shown there, or
     * null when nothing was - and for a real block only drawn differently (the
     * snowy grass), which the player is digging and is left to the game.
     */
    static BlockState takeDown(ServerPlayer player, BlockPos pos) {
        Seen one = seen.get(player.getUUID());
        if (one == null || one.dimension != player.serverLevel().dimension()) return null;
        List<Fake> fakes = one.chunks.get(ChunkPos.asLong(pos.getX() >> 4, pos.getZ() >> 4));
        if (fakes == null) return null;
        Fake hit = null;
        for (Fake fake : fakes) if (fake.pos().equals(pos)) hit = fake;
        if (hit == null || redrawn(hit)) return null;
        if (broken.add(pos.asLong())) writeBroken();
        BlockPos under = hit.shown().is(Blocks.SNOW) ? pos.below() : null;
        for (ServerPlayer other : player.serverLevel().getServer().getPlayerList().getPlayers()) {
            Seen theirs = seen.get(other.getUUID());
            if (theirs == null || theirs.dimension != one.dimension) continue;
            drop(other, theirs, pos);
            if (under != null) drop(other, theirs, under);
        }
        return hit.shown();
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
     * The first hit on a decoration takes it down and is called off, so the real
     * block under it stays as it is and drops nothing. Before the game's own
     * checks: a decoration standing in air never reaches them at all.
     */
    @SubscribeEvent
    public void onHit(PlayerInteractEvent.LeftClickBlock event) {
        if (season == null || event.getAction() != PlayerInteractEvent.LeftClickBlock.Action.START) return;
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        BlockState shown = takeDown(player, event.getPos());
        if (shown == null) return;
        event.setCanceled(true);
        if (pumpkin(shown)) SeasonalHalloween.trap(player, player.serverLevel(), event.getPos());
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

    private static void writeBroken() {
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

    private static void show(ServerPlayer player, Fake fake) {
        player.connection.send(new ClientboundBlockUpdatePacket(fake.pos(), fake.shown()));
    }

    /** The block as it really is now, which is what the player's game shows after. */
    private static void restore(ServerPlayer player, Fake fake) {
        player.connection.send(new ClientboundBlockUpdatePacket(player.serverLevel(), fake.pos()));
    }

    /**
     * Take a cobweb down for a player about to reach it, on every tick. A web
     * slows whoever is in it, and their game would move them as slowed while the
     * server, which holds air there, would not. The faster they go the earlier it
     * goes; it stays down until the chunk is decided again.
     */
    private static void websNear(MinecraftServer server) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            Seen one = seen.get(player.getUUID());
            if (one == null || one.dimension != player.serverLevel().dimension()) continue;
            Vec3 center = player.getBoundingBox().getCenter();
            double speed = one.last == null ? 0 : center.distanceTo(one.last);
            one.last = center;
            double reach = WEB_REACH + speed * WEB_REACH_PER_SPEED;
            double reachSq = reach * reach;
            ChunkPos at = player.chunkPosition();
            int span = 1 + (int) Math.ceil(reach / 16);
            for (int dx = -span; dx <= span; dx++) {
                for (int dz = -span; dz <= span; dz++) {
                    long key = ChunkPos.asLong(at.x + dx, at.z + dz);
                    List<Fake> fakes = one.chunks.get(key);
                    if (fakes == null || fakes.isEmpty()) continue;
                    List<Fake> kept = null;
                    for (int i = 0; i < fakes.size(); i++) {
                        Fake fake = fakes.get(i);
                        boolean near = fake.shown().is(Blocks.COBWEB)
                                && center.distanceToSqr(Vec3.atCenterOf(fake.pos())) <= reachSq;
                        if (near && kept == null) kept = new ArrayList<>(fakes.subList(0, i));
                        if (near) restore(player, fake);
                        else if (kept != null) kept.add(fake);
                    }
                    if (kept != null) one.chunks.put(key, kept);
                }
            }
        }
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
                    fakes.add(new Fake(web, level.getBlockState(web), Blocks.COBWEB.defaultBlockState()));
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
