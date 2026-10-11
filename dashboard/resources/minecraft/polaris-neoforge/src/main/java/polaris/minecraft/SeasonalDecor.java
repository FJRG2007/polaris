package polaris.minecraft;

import com.google.gson.JsonObject;
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
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
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
 * leaves of a natural tree, at least three blocks clear of the ground; in winter
 * a thin layer of snow, which nothing collides with, lies on some grass and snow
 * falls around a player standing under the open sky. Only on ground whose every
 * neighbour is natural - a block anybody placed nearby, a path, a fence, keeps
 * the spot bare - and only on leaves the game grew (a player's are persistent).
 * Nothing near what an event batch built ({@link #avoid}).
 *
 * Sparse and the same each time: every chunk is decided from the world's seed
 * and its coordinates alone, so a pumpkin never moves. A few chunks around each
 * player are decided per second, within a budget, and what was sent is sent
 * again now and then - a chunk the player's game loaded again gets it back,
 * and a block that changed since loses it.
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

    /** One block a player's game was told is something else, and what it really was. */
    private record Fake(BlockPos pos, BlockState real, BlockState shown) {}

    private static final class Seen {
        ResourceKey<Level> dimension;
        final Map<Long, List<Fake>> chunks = new HashMap<>();
    }

    private static Season season;
    private static long untilMillis;
    private static final Map<UUID, Seen> seen = new HashMap<>();
    /** {minX, minZ, maxX, maxZ}, padded, oldest first. */
    private static final ArrayDeque<long[]> avoided = new ArrayDeque<>();
    private static int ticks;

    // ------------------------------------------------------------------ commands

    /** {@code polaris season set <name> <seconds>}. */
    static JsonObject set(MinecraftServer server, String name, long seconds) {
        Season next = Season.named(name);
        if (next == null) return refused("unknownSeason");
        if (next != season) revertAll(server);
        season = next;
        untilMillis = System.currentTimeMillis() + Math.min(Math.max(seconds, 1), MAX_HOLD_SECONDS) * 1000L;
        return status();
    }

    /** {@code polaris season clear}. */
    static JsonObject clear(MinecraftServer server) {
        if (season != null) revertAll(server);
        season = null;
        return status();
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

    private static boolean isAvoided(int chunkX, int chunkZ) {
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
        } catch (RuntimeException failed) {
            // A tick must never fail over a decoration: put everything back and stop.
            PolarisMod.LOG.error("Polaris seasonal decorations failed and are off until told again", failed);
            try {
                clear(server);
            } catch (RuntimeException ignored) {
                season = null;
                seen.clear();
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
            List<Fake> kept = new ArrayList<>(chunk.getValue().size());
            for (Fake fake : chunk.getValue()) {
                if (level.getBlockState(fake.pos()) == fake.real()) {
                    show(player, fake);
                    kept.add(fake);
                } else {
                    restore(player, fake);
                }
            }
            chunk.setValue(kept);
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

    private static void show(ServerPlayer player, Fake fake) {
        player.connection.send(new ClientboundBlockUpdatePacket(fake.pos(), fake.shown()));
    }

    /** The block as it really is now, which is what the player's game shows after. */
    private static void restore(ServerPlayer player, Fake fake) {
        player.connection.send(new ClientboundBlockUpdatePacket(player.serverLevel(), fake.pos()));
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
            if (random.nextInt(100) < 22) {
                for (int tries = 0; tries < 4; tries++) {
                    BlockPos ground = groundAt(level, baseX + 2 + random.nextInt(12), baseZ + 2 + random.nextInt(12));
                    int kind = random.nextInt(3);
                    Direction facing = Direction.from2DDataValue(random.nextInt(4));
                    if (ground == null || !naturalGrass(level, ground)) continue;
                    BlockState shown = switch (kind) {
                        case 0 -> Blocks.CARVED_PUMPKIN.defaultBlockState().setValue(HorizontalDirectionalBlock.FACING, facing);
                        case 1 -> Blocks.JACK_O_LANTERN.defaultBlockState().setValue(HorizontalDirectionalBlock.FACING, facing);
                        default -> Blocks.PUMPKIN.defaultBlockState();
                    };
                    fakes.add(new Fake(ground, level.getBlockState(ground), shown));
                    break;
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
        }
        return fakes;
    }

    /** The top solid block of a column, ignoring leaves, or null outside the world. */
    private static BlockPos groundAt(ServerLevel level, int x, int z) {
        int y = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
        return y <= level.getMinY() ? null : new BlockPos(x, y, z);
    }

    /**
     * A grass block with open air on it, on natural ground, in a 5x5 patch of
     * nothing but natural blocks from one below to one above it. A block anybody
     * placed - a path, a slab, a plank, a torch - rules the spot out.
     */
    private static boolean naturalGrass(ServerLevel level, BlockPos ground) {
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

    private static boolean natural(BlockState state) {
        if (state.isAir()) return true;
        if (state.is(BlockTags.LEAVES)) return wild(state);
        return state.is(BlockTags.DIRT) || state.is(BlockTags.BASE_STONE_OVERWORLD) || state.is(BlockTags.SAND)
                || state.is(Blocks.GRAVEL) || state.is(BlockTags.FLOWERS) || state.is(BlockTags.REPLACEABLE);
    }

    /** Leaves the game grew: a player's are persistent. */
    private static boolean wild(BlockState state) {
        return state.hasProperty(LeavesBlock.PERSISTENT) && !state.getValue(LeavesBlock.PERSISTENT);
    }

    /** Where a cobweb hangs under a natural tree's lowest leaves in this column, or null. */
    private static BlockPos webUnder(ServerLevel level, int x, int z) {
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
