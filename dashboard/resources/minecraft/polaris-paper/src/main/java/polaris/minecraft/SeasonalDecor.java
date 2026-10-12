package polaris.minecraft;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.HeightMap;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Particle;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Directional;
import org.bukkit.block.data.Snowable;
import org.bukkit.block.data.type.Leaves;
import org.bukkit.block.data.type.Snow;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.util.Vector;

/**
 * The season Polaris says it is, drawn on each player's screen and nowhere else -
 * the same as the NeoForge mod's {@code SeasonalDecor}, through Bukkit.
 *
 * The dashboard decides the season from its own calendar and says so with
 * {@code polaris season set <halloween|winter> <seconds>} (kept that long, and
 * told again while it lasts) or {@code polaris season clear}. This plugin keeps
 * no dates of its own.
 *
 * Everything is a block change sent to one player ({@code sendBlockChange}),
 * never set in the world: nothing reaches a region file, and a chunk the game
 * loads again shows the world as it is. Pumpkins take the place of a grass block
 * in the ground (the same full block underfoot), cobwebs hang under the leaves of
 * a natural tree at least three blocks clear of the ground - and a player's game
 * loses one before they can reach it ({@link #websNear}) - and in winter a thin
 * layer of snow, which nothing collides with, lies on some grass while snow falls
 * round a player under the open sky. Only on ground whose every neighbour is
 * natural, and only on leaves the game grew (a player's are persistent). While an
 * event runs the dashboard clears it, so nothing is drawn over an arena.
 *
 * Sparse and the same each time: every chunk is decided from the world's seed
 * and its coordinates alone. A few chunks round each player are decided per
 * second, within a budget, and what was sent is sent again now and then - a
 * chunk the game loaded again gets it back, a block that changed loses it.
 *
 * Main thread only: the command and the timer both run there.
 */
final class SeasonalDecor implements Listener {
    enum Season {
        HALLOWEEN(0x5EA50171L), WINTER(0x5EA50172L);

        final long salt;

        Season(long salt) {
            this.salt = salt;
        }

        static Season named(String name) {
            return switch (name.toLowerCase(Locale.ROOT)) {
                case "halloween" -> HALLOWEEN;
                case "winter" -> WINTER;
                default -> null;
            };
        }
    }

    private static final int RADIUS = 3;
    private static final int FORGET = 12;
    private static final int NEW_PER_PLAYER = 4;
    private static final int NEW_PER_PASS = 16;
    private static final int PASS_TICKS = 20;
    private static final int RESEND_TICKS = 600;
    private static final int SNOW_TICKS = 5;
    private static final int ASH_TICKS = 40;
    private static final long MAX_HOLD_SECONDS = 24 * 60 * 60;
    /** How near a cobweb a player comes before their game loses it, in blocks, and
     *  how much further each block they moved in the last tick takes that. */
    private static final double WEB_REACH = 6;
    private static final double WEB_REACH_PER_SPEED = 12;
    /** Halloween chunks with a pumpkin, and of those, the ones with two, in percent. */
    private static final int PUMPKIN_CHUNKS = 45;
    private static final int TWO_PUMPKIN_CHUNKS = 30;

    /** One block a player's game was told is something else, and what it really was. */
    private record Fake(Location at, BlockData real, BlockData shown) {}

    private static final class Seen {
        UUID world;
        final Map<Long, List<Fake>> chunks = new HashMap<>();
        /** Where the player was on the last tick, for how fast they move. */
        Vector last;
    }

    private final Plugin plugin;
    private final Map<UUID, Seen> seen = new HashMap<>();
    private Season season;
    private long untilMillis;
    private BukkitTask timer;
    private int ticks;
    private final Random particles = new Random();
    private final SeasonalMobs mobs = new SeasonalMobs(this);

    SeasonalDecor(Plugin plugin) {
        this.plugin = plugin;
    }

    /** The season's mobs, which listen for spawns alongside this. */
    SeasonalMobs mobs() {
        return mobs;
    }

    /** The season showing now, or null. */
    Season season() {
        return season;
    }

    void stop() {
        if (timer != null) timer.cancel();
        timer = null;
        revertAll();
        mobs.revert();
        season = null;
    }

    // ------------------------------------------------------------------ commands

    /** {@code polaris season set <name> <seconds> [<spawns%> <golems%>]|clear|status}:
     *  the mob settings are {@link SeasonalMobs}'. */
    JsonObject answer(String[] args) {
        if (args.length == 1 && args[0].equalsIgnoreCase("clear")) return clear();
        if (args.length == 1 && args[0].equalsIgnoreCase("status")) return status();
        if ((args.length == 3 || args.length == 5) && args[0].equalsIgnoreCase("set")) {
            Season next = Season.named(args[1]);
            if (next == null) return SoundPack.refused("unknownSeason");
            long seconds;
            int spawns = SeasonalMobs.USUAL;
            int golems = 0;
            try {
                seconds = Long.parseLong(args[2]);
                if (args.length == 5) {
                    spawns = Integer.parseInt(args[3]);
                    golems = Integer.parseInt(args[4]);
                }
            } catch (NumberFormatException bad) {
                return SoundPack.refused("usage");
            }
            if (seconds < 1 || seconds > MAX_HOLD_SECONDS) return SoundPack.refused("usage");
            if (spawns < SeasonalMobs.USUAL || spawns > SeasonalMobs.MAX_PERCENT) return SoundPack.refused("usage");
            if (golems < 0 || golems > SeasonalMobs.MAX_PERCENT) return SoundPack.refused("usage");
            if (next != season) {
                revertAll();
                mobs.revert();
            }
            season = next;
            untilMillis = System.currentTimeMillis() + seconds * 1000L;
            mobs.configure(spawns, golems);
            if (timer == null) timer = Bukkit.getScheduler().runTaskTimer(plugin, this::tick, 1, 1);
            return status();
        }
        return SoundPack.refused("usage");
    }

    private JsonObject clear() {
        revertAll();
        mobs.revert();
        season = null;
        if (timer != null) timer.cancel();
        timer = null;
        return status();
    }

    private JsonObject status() {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("season", season == null ? "" : season.name().toLowerCase(Locale.ROOT));
        reply.addProperty("untilMillis", season == null ? 0 : untilMillis);
        int blocks = 0;
        for (Seen one : seen.values()) for (List<Fake> fakes : one.chunks.values()) blocks += fakes.size();
        reply.addProperty("players", seen.size());
        reply.addProperty("blocks", blocks);
        mobs.status(reply);
        return reply;
    }

    // ------------------------------------------------------------------ the timer

    private void tick() {
        if (season == null) return;
        try {
            if (System.currentTimeMillis() > untilMillis) {
                clear();
                return;
            }
            ticks++;
            if (season == Season.HALLOWEEN) websNear();
            if (season == Season.WINTER && ticks % SNOW_TICKS == 0) particles(true);
            if (season == Season.HALLOWEEN && ticks % ASH_TICKS == 0) particles(false);
            if (ticks % PASS_TICKS == 0) pass(ticks % RESEND_TICKS == 0);
            mobs.tick();
        } catch (RuntimeException failed) {
            // A tick must never fail over a decoration: put everything back and stop.
            plugin.getLogger().severe("Polaris seasonal decorations failed and are off until told again: " + failed);
            try {
                clear();
            } catch (RuntimeException ignored) {
                season = null;
                seen.clear();
                mobs.forget();
            }
        }
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        seen.remove(event.getPlayer().getUniqueId());
    }

    private void pass(boolean resend) {
        int budget = NEW_PER_PASS;
        for (Player player : Bukkit.getOnlinePlayers()) {
            Seen one = seen.computeIfAbsent(player.getUniqueId(), id -> new Seen());
            World world = player.getWorld();
            // A game that changed world dropped every chunk it had.
            if (!world.getUID().equals(one.world)) {
                one.chunks.clear();
                one.world = world.getUID();
            }
            if (world.getEnvironment() != World.Environment.NORMAL) continue;
            int atX = player.getLocation().getBlockX() >> 4;
            int atZ = player.getLocation().getBlockZ() >> 4;
            one.chunks.keySet().removeIf(key -> Math.abs(chunkX(key) - atX) > FORGET
                    || Math.abs(chunkZ(key) - atZ) > FORGET);
            if (resend) resend(player, world, one, atX, atZ);
            budget -= decorateAround(player, world, one, atX, atZ, Math.min(budget, NEW_PER_PLAYER));
            if (budget <= 0 && !resend) break;
        }
    }

    private int decorateAround(Player player, World world, Seen one, int atX, int atZ, int budget) {
        int done = 0;
        for (int ring = 0; ring <= RADIUS && done < budget; ring++) {
            for (int dx = -ring; dx <= ring && done < budget; dx++) {
                for (int dz = -ring; dz <= ring && done < budget; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) != ring) continue;
                    int cx = atX + dx;
                    int cz = atZ + dz;
                    long key = chunkKey(cx, cz);
                    if (one.chunks.containsKey(key) || !world.isChunkLoaded(cx, cz)) continue;
                    List<Fake> fakes = decide(world, cx, cz, season);
                    one.chunks.put(key, fakes);
                    for (Fake fake : fakes) player.sendBlockChange(fake.at(), fake.shown());
                    done++;
                }
            }
        }
        return done;
    }

    private void resend(Player player, World world, Seen one, int atX, int atZ) {
        for (Map.Entry<Long, List<Fake>> chunk : one.chunks.entrySet()) {
            int cx = chunkX(chunk.getKey());
            int cz = chunkZ(chunk.getKey());
            if (Math.abs(cx - atX) > RADIUS || Math.abs(cz - atZ) > RADIUS) continue;
            if (chunk.getValue().isEmpty() || !world.isChunkLoaded(cx, cz)) continue;
            List<Fake> kept = new ArrayList<>(chunk.getValue().size());
            for (Fake fake : chunk.getValue()) {
                BlockData now = fake.at().getBlock().getBlockData();
                if (now.equals(fake.real())) {
                    player.sendBlockChange(fake.at(), fake.shown());
                    kept.add(fake);
                } else {
                    player.sendBlockChange(fake.at(), now);
                }
            }
            chunk.setValue(kept);
        }
    }

    /**
     * Whether this player is shown a pumpkin on this block; if so it is taken
     * down for them (their game shows the real block again) and not shown again
     * until the chunk is decided anew. For {@link SeasonalHalloween}'s traps.
     */
    boolean takePumpkin(Player player, Block block) {
        Seen one = seen.get(player.getUniqueId());
        if (one == null || !player.getWorld().getUID().equals(one.world)) return false;
        long key = chunkKey(block.getX() >> 4, block.getZ() >> 4);
        List<Fake> fakes = one.chunks.get(key);
        if (fakes == null) return false;
        for (int i = 0; i < fakes.size(); i++) {
            Fake fake = fakes.get(i);
            Material shown = fake.shown().getMaterial();
            boolean pumpkin = shown == Material.PUMPKIN || shown == Material.CARVED_PUMPKIN || shown == Material.JACK_O_LANTERN;
            if (!pumpkin || fake.at().getBlockX() != block.getX() || fake.at().getBlockY() != block.getY()
                    || fake.at().getBlockZ() != block.getZ()) continue;
            List<Fake> kept = new ArrayList<>(fakes);
            kept.remove(i);
            one.chunks.put(key, kept);
            player.sendBlockChange(fake.at(), block.getBlockData());
            return true;
        }
        return false;
    }

    /** Everything a player was shown taken down, to be decided again on the next pass. */
    void redraw() {
        revertAll();
    }

    private void revertAll() {
        for (Player player : Bukkit.getOnlinePlayers()) {
            Seen one = seen.get(player.getUniqueId());
            if (one == null || !player.getWorld().getUID().equals(one.world)) continue;
            for (List<Fake> fakes : one.chunks.values()) {
                for (Fake fake : fakes) player.sendBlockChange(fake.at(), fake.at().getBlock().getBlockData());
            }
        }
        seen.clear();
    }

    /**
     * Take a cobweb down for a player about to reach it, on every tick. A web
     * slows whoever is in it, and their game would move them as slowed while the
     * server, which holds air there, would not. The faster they go the earlier it
     * goes; it stays down until the chunk is decided again.
     */
    private void websNear() {
        for (Player player : Bukkit.getOnlinePlayers()) {
            Seen one = seen.get(player.getUniqueId());
            if (one == null || !player.getWorld().getUID().equals(one.world)) continue;
            Vector center = player.getBoundingBox().getCenter();
            double speed = one.last == null ? 0 : center.distance(one.last);
            one.last = center;
            double reach = WEB_REACH + speed * WEB_REACH_PER_SPEED;
            double reachSq = reach * reach;
            int atX = player.getLocation().getBlockX() >> 4;
            int atZ = player.getLocation().getBlockZ() >> 4;
            int span = 1 + (int) Math.ceil(reach / 16);
            for (int dx = -span; dx <= span; dx++) {
                for (int dz = -span; dz <= span; dz++) {
                    long key = chunkKey(atX + dx, atZ + dz);
                    List<Fake> fakes = one.chunks.get(key);
                    if (fakes == null || fakes.isEmpty()) continue;
                    List<Fake> kept = null;
                    for (int i = 0; i < fakes.size(); i++) {
                        Fake fake = fakes.get(i);
                        boolean near = fake.shown().getMaterial() == Material.COBWEB
                                && center.distanceSquared(fake.at().clone().add(0.5, 0.5, 0.5).toVector()) <= reachSq;
                        if (near && kept == null) kept = new ArrayList<>(fakes.subList(0, i));
                        if (near) player.sendBlockChange(fake.at(), fake.at().getBlock().getBlockData());
                        else if (kept != null) kept.add(fake);
                    }
                    if (kept != null) one.chunks.put(key, kept);
                }
            }
        }
    }

    private void particles(boolean snow) {
        for (Player player : Bukkit.getOnlinePlayers()) {
            World world = player.getWorld();
            if (world.getEnvironment() != World.Environment.NORMAL || player.getGameMode() == GameMode.SPECTATOR)
                continue;
            Location at = player.getLocation();
            if (world.getHighestBlockYAt(at.getBlockX(), at.getBlockZ(), HeightMap.MOTION_BLOCKING) > player.getEyeLocation().getY())
                continue;
            if (snow) {
                player.spawnParticle(Particle.SNOWFLAKE, at.getX(), at.getY() + 6, at.getZ(), 6, 7, 2, 7, 0);
            } else {
                long time = world.getTime();
                if (time >= 13_000 && time <= 23_000 && particles.nextBoolean())
                    player.spawnParticle(Particle.WHITE_ASH, at.getX(), at.getY() + 2, at.getZ(), 4, 6, 2, 6, 0);
            }
        }
    }

    // ------------------------------------------------------------------ deciding

    private static long chunkKey(int x, int z) {
        return ((long) x << 32) | (z & 0xFFFFFFFFL);
    }

    private static int chunkX(long key) {
        return (int) (key >> 32);
    }

    private static int chunkZ(long key) {
        return (int) key;
    }

    private static final BlockFace[] FACINGS = {BlockFace.SOUTH, BlockFace.WEST, BlockFace.NORTH, BlockFace.EAST};

    /** What a chunk shows this season: the same every time it is asked. */
    private static List<Fake> decide(World world, int cx, int cz, Season season) {
        Random random = new Random(world.getSeed() ^ (chunkKey(cx, cz) * 0x9E3779B97F4A7C15L) ^ season.salt);
        List<Fake> fakes = new ArrayList<>(4);
        int baseX = cx << 4;
        int baseZ = cz << 4;
        if (season == Season.HALLOWEEN) {
            // Most chunks get one, some two, and over half of them are lit: a
            // jack o'lantern is what a player sees from across a field at night.
            if (random.nextInt(100) < PUMPKIN_CHUNKS) {
                int pumpkins = random.nextInt(100) < TWO_PUMPKIN_CHUNKS ? 2 : 1;
                for (int tries = 0; tries < 8 && pumpkins > 0; tries++) {
                    Block ground = groundAt(world, baseX + 2 + random.nextInt(12), baseZ + 2 + random.nextInt(12));
                    int kind = random.nextInt(100);
                    BlockFace facing = FACINGS[random.nextInt(4)];
                    if (ground == null || !naturalGrass(ground) || taken(fakes, ground)) continue;
                    BlockData shown = kind < 55
                            ? facing(Material.JACK_O_LANTERN, facing)
                            : kind < 85 ? facing(Material.CARVED_PUMPKIN, facing) : Material.PUMPKIN.createBlockData();
                    fakes.add(new Fake(ground.getLocation(), ground.getBlockData(), shown));
                    pumpkins--;
                }
            }
            if (random.nextInt(100) < 35) {
                int webs = 1 + random.nextInt(2);
                for (int tries = 0; tries < 6 && webs > 0; tries++) {
                    Block web = webUnder(world, baseX + random.nextInt(16), baseZ + random.nextInt(16));
                    if (web == null) continue;
                    fakes.add(new Fake(web.getLocation(), web.getBlockData(), Material.COBWEB.createBlockData()));
                    webs--;
                }
            }
        } else {
            if (random.nextInt(100) < 30) {
                int layers = 1 + random.nextInt(3);
                for (int tries = 0; tries < 6 && layers > 0; tries++) {
                    Block ground = groundAt(world, baseX + 2 + random.nextInt(12), baseZ + 2 + random.nextInt(12));
                    if (ground == null || !naturalGrass(ground)) continue;
                    Block above = ground.getRelative(BlockFace.UP);
                    Snow snow = (Snow) Material.SNOW.createBlockData();
                    snow.setLayers(1);
                    fakes.add(new Fake(above.getLocation(), above.getBlockData(), snow));
                    BlockData grass = ground.getBlockData();
                    if (grass instanceof Snowable snowable) {
                        Snowable snowy = (Snowable) snowable.clone();
                        snowy.setSnowy(true);
                        fakes.add(new Fake(ground.getLocation(), grass, snowy));
                    }
                    layers--;
                }
            }
            // Christmas: more snow, and lights on the trees (SeasonalWinterDecor).
            SeasonalWinterDecor.decide(world, cx, cz, (block, shown) -> fakes.add(new Fake(block.getLocation(), block.getBlockData(), shown)));
        }
        return fakes;
    }

    /** Whether a pumpkin already stands within a few blocks of this one. */
    private static boolean taken(List<Fake> fakes, Block ground) {
        for (Fake fake : fakes) {
            Location at = fake.at();
            int apart = Math.abs(at.getBlockX() - ground.getX()) + Math.abs(at.getBlockY() - ground.getY())
                    + Math.abs(at.getBlockZ() - ground.getZ());
            if (apart <= 4) return true;
        }
        return false;
    }

    private static BlockData facing(Material material, BlockFace face) {
        BlockData data = material.createBlockData();
        if (data instanceof Directional directional) directional.setFacing(face);
        return data;
    }

    /** The top solid block of a column, ignoring leaves, or null at the bottom of the world. */
    static Block groundAt(World world, int x, int z) {
        Block top = world.getHighestBlockAt(x, z, HeightMap.MOTION_BLOCKING_NO_LEAVES);
        return top.getY() <= world.getMinHeight() ? null : top;
    }

    /**
     * A grass block with open air on it, on natural ground, in a 5x5 patch of
     * nothing but natural blocks from one below to one above it.
     */
    static boolean naturalGrass(Block ground) {
        if (ground.getType() != Material.GRASS_BLOCK) return false;
        if (!ground.getRelative(BlockFace.UP).getType().isAir()) return false;
        if (!Tag.DIRT.isTagged(ground.getRelative(BlockFace.DOWN).getType())) return false;
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                for (int dy = -1; dy <= 1; dy++) {
                    if (!natural(ground.getRelative(dx, dy, dz))) return false;
                }
            }
        }
        return true;
    }

    static boolean natural(Block block) {
        Material type = block.getType();
        if (type.isAir()) return true;
        if (Tag.LEAVES.isTagged(type)) return wild(block.getBlockData());
        return Tag.DIRT.isTagged(type) || Tag.BASE_STONE_OVERWORLD.isTagged(type) || Tag.SAND.isTagged(type)
                || type == Material.GRAVEL || Tag.FLOWERS.isTagged(type) || Tag.REPLACEABLE.isTagged(type);
    }

    /** Leaves the game grew: a player's are persistent. */
    static boolean wild(BlockData data) {
        return data instanceof Leaves leaves && !leaves.isPersistent();
    }

    /** Where a cobweb hangs under a natural tree's lowest leaves in this column, or null. */
    static Block webUnder(World world, int x, int z) {
        Block at = world.getHighestBlockAt(x, z, HeightMap.MOTION_BLOCKING);
        if (!wild(at.getBlockData())) return null;
        for (int down = 0; down < 8 && wild(at.getRelative(BlockFace.DOWN).getBlockData()); down++)
            at = at.getRelative(BlockFace.DOWN);
        Block web = at.getRelative(BlockFace.DOWN);
        // Three clear blocks under it: high over anybody's head, never in a path.
        for (int clear = 0; clear < 4; clear++) if (!web.getRelative(0, -clear, 0).getType().isAir()) return null;
        return web;
    }
}
