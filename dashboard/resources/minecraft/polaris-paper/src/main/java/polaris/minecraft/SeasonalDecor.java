package polaris.minecraft;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import java.util.function.BiConsumer;
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
import org.bukkit.enchantments.Enchantment;
import org.bukkit.entity.BlockDisplay;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.player.PlayerAnimationEvent;
import org.bukkit.event.player.PlayerAnimationType;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.util.BoundingBox;
import org.bukkit.util.RayTraceResult;
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
 * never set in the world - or, for a cobweb, a display entity hidden from
 * everybody else and never saved: nothing reaches a region file, and a chunk the
 * game loads again shows the world as it is. Pumpkins take the place of a grass block
 * in the ground (the same full block underfoot), cobwebs hang under the leaves of
 * a natural tree at least three blocks clear of the ground - a block display only
 * that player is shown ({@link #showWeb}), since a web block slowed them on their
 * screen as they passed through it while the server, which holds air there, did
 * not, so it had to vanish before they reached it - and in winter a thin
 * layer of snow, which nothing collides with, lies on some grass while snow falls
 * round a player under the open sky. Only on ground whose every neighbour is
 * natural, and only on leaves the game grew (a player's are persistent). While an
 * event runs the dashboard clears it, so nothing is drawn over an arena.
 *
 * Sparse and the same each time: every chunk is decided from the world's seed
 * and its coordinates alone. A few chunks round each player are decided per
 * second, within a budget, and what was sent is sent again now and then - a
 * chunk the game loaded again gets it back, a block that changed loses it. A
 * chunk past the view distance is forgotten, as the player's game forgot it, so
 * it is decided and shown again as soon as they come back.
 *
 * A decoration a player breaks comes down for everybody and stays down for the
 * rest of the season ({@link BrokenDecor}, kept beside the world): every hit on
 * it is called off, so the real block under it is neither broken nor dropped. A
 * pumpkin takes as long to dig as a real one and drops itself ({@link #onHit});
 * anything else comes down on the first hit. On Paper 1.21.4 and later, pick
 * block on one gives the decoration, not the real block under it ({@link #pick}).
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
    /** How often the decorations knocked down since the last write are written, so a
     *  player breaking a row of them costs one write instead of one each. */
    private static final int FLUSH_TICKS = 200;
    private static final int SNOW_TICKS = 5;
    private static final int ASH_TICKS = 40;
    private static final long MAX_HOLD_SECONDS = 24 * 60 * 60;
    /** How far a pick reaches, in blocks: past the game's own reach in creative. */
    private static final double PICK_REACH = 6;
    /** Where a pick can be answered (Paper 1.21.4 and later). */
    private static final String PICK_EVENT = "io.papermc.paper.event.player.PlayerPickBlockEvent";
    /** Halloween chunks with a pumpkin, and of those, the ones with two, in percent. */
    private static final int PUMPKIN_CHUNKS = 45;
    private static final int TWO_PUMPKIN_CHUNKS = 30;
    /** Where the decorations players knocked down are kept, beside the world. */
    private static final String BROKEN_FILE = "polaris-season-broken.json";

    /** One block a player's game was told is something else, and what it really was. */
    private record Fake(Location at, BlockData real, BlockData shown) {}

    private static final class Seen {
        UUID world;
        final Map<Long, List<Fake>> chunks = new HashMap<>();
        /** The cobwebs drawn for this player, by block: displays nobody else is shown,
         *  never saved with the world. */
        final Map<Long, BlockDisplay> webs = new HashMap<>();
    }

    private final Plugin plugin;
    private final Map<UUID, Seen> seen = new HashMap<>();
    private Season season;
    /** Whether the dashboard has said anything since this plugin started. */
    private boolean told;
    private long untilMillis;
    private BukkitTask timer;
    private int ticks;
    private final Random particles = new Random();
    private final SeasonalMobs mobs = new SeasonalMobs(this);
    private BrokenDecor broken = new BrokenDecor();
    private Path brokenFile;
    /** Knocked down since the list was last written. */
    private boolean brokenDirty;
    private BiConsumer<Player, Block> pumpkinTaken = (player, block) -> {};

    /** A pumpkin a player is digging: where, the tick they started and last swung at it, and how much of it each tick takes. */
    private static final class Dig {
        final Block block;
        final BlockData shown;
        final int since;
        final double perTick;
        int swung;

        Dig(Block block, BlockData shown, int since, double perTick) {
            this.block = block;
            this.shown = shown;
            this.since = since;
            this.perTick = perTick;
            this.swung = since;
        }
    }

    private final Map<UUID, Dig> digs = new HashMap<>();
    /** How many ticks without a swing at it end a dig: the player let go, or looked away. */
    private static final int DIG_IDLE_TICKS = 6;
    /** How much a dig takes each tick of a block of hardness one, by the game's own sum:
     *  thirty when the hand can harvest it, as anybody can a pumpkin. */
    private static final double DIG_DIVISOR = 30;

    SeasonalDecor(Plugin plugin) {
        this.plugin = plugin;
    }

    /** Answer picks on decorations where the server has the event for it: Paper 1.21.4 and later. */
    void listenForPicks() {
        try {
            Class.forName(PICK_EVENT, false, SeasonalDecor.class.getClassLoader());
        } catch (ClassNotFoundException absent) {
            return;
        }
        try {
            Listener listener = (Listener) Class.forName("polaris.minecraft.SeasonalDecorPick")
                    .getDeclaredConstructor(SeasonalDecor.class).newInstance(this);
            Bukkit.getPluginManager().registerEvents(listener, plugin);
        } catch (ReflectiveOperationException | LinkageError | ClassCastException failed) {
            plugin.getLogger().warning("Polaris seasons: pick block on a decoration gives the block under it (" + failed + ").");
        }
    }

    /** The season's mobs, which listen for spawns alongside this. */
    SeasonalMobs mobs() {
        return mobs;
    }

    /** The season showing now, or null. */
    Season season() {
        return season;
    }

    /** Whether a season or a clear has been said since start: a null season is only known to be none then. */
    boolean told() {
        return told;
    }

    void stop() {
        if (timer != null) timer.cancel();
        timer = null;
        revertAll();
        mobs.revert();
        flushBroken();
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
            told = true;
            keepBroken(next);
            untilMillis = System.currentTimeMillis() + seconds * 1000L;
            mobs.configure(spawns, golems);
            if (timer == null) timer = Bukkit.getScheduler().runTaskTimer(plugin, this::tick, 1, 1);
            return status();
        }
        return SoundPack.refused("usage");
    }

    private JsonObject clear() {
        revertAll();
        flushBroken();
        mobs.revert();
        season = null;
        told = true;
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
        reply.addProperty("broken", broken.size());
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
            if (season == Season.WINTER && ticks % SNOW_TICKS == 0) particles(true);
            if (season == Season.HALLOWEEN && ticks % ASH_TICKS == 0) particles(false);
            if (ticks % PASS_TICKS == 0) pass(ticks % RESEND_TICKS == 0);
            if (ticks % FLUSH_TICKS == 0) flushBroken();
            dig();
            mobs.tick();
        } catch (RuntimeException failed) {
            // A tick must never fail over a decoration: put everything back and stop.
            plugin.getLogger().severe("Polaris seasonal decorations failed and are off until told again: " + failed);
            try {
                clear();
            } catch (RuntimeException ignored) {
                season = null;
                for (Seen one : seen.values()) removeWebs(one);
                seen.clear();
                digs.clear();
                mobs.forget();
            }
        }
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        Seen one = seen.remove(event.getPlayer().getUniqueId());
        if (one != null) removeWebs(one);
        digs.remove(event.getPlayer().getUniqueId());
    }

    private void pass(boolean resend) {
        int budget = NEW_PER_PASS;
        for (Player player : Bukkit.getOnlinePlayers()) {
            Seen one = seen.computeIfAbsent(player.getUniqueId(), id -> new Seen());
            World world = player.getWorld();
            // A game that changed world dropped every chunk it had.
            if (!world.getUID().equals(one.world)) {
                one.chunks.clear();
                removeWebs(one);
                one.world = world.getUID();
            }
            if (world.getEnvironment() != World.Environment.NORMAL) continue;
            int atX = player.getLocation().getBlockX() >> 4;
            int atZ = player.getLocation().getBlockZ() >> 4;
            int forget = Math.min(FORGET, Bukkit.getViewDistance());
            one.chunks.entrySet().removeIf(chunk -> {
                long key = chunk.getKey();
                if (Math.abs(chunkX(key) - atX) <= forget && Math.abs(chunkZ(key) - atZ) <= forget) return false;
                for (Fake fake : chunk.getValue()) if (web(fake)) restore(player, one, fake);
                return true;
            });
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
                    fakes.removeIf(this::wasBroken);
                    one.chunks.put(key, fakes);
                    for (Fake fake : fakes) show(player, one, fake);
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
                if (fake.at().getBlock().getBlockData().equals(fake.real())) {
                    show(player, one, fake);
                    kept.add(fake);
                } else {
                    restore(player, one, fake);
                }
            }
            chunk.setValue(kept);
        }
    }

    /** Called with a decorative pumpkin a player knocked down: {@link SeasonalHalloween}'s traps. */
    void onPumpkinTaken(BiConsumer<Player, Block> then) {
        pumpkinTaken = then;
    }

    /**
     * A player hit a decoration they are shown: it comes down for everybody and
     * is remembered as broken for the rest of the season. Thin snow takes the
     * snowy look of the ground under it along. Returns what was shown there, or
     * null when nothing was - and for a real block only drawn differently (the
     * snowy grass), which the player is digging and is left to the game.
     */
    BlockData takeDown(Player player, Block block) {
        Fake hit = shownAt(player, block);
        if (hit == null) return null;
        Seen one = seen.get(player.getUniqueId());
        if (broken.add(blockKey(block.getX(), block.getY(), block.getZ()))) brokenDirty = true;
        boolean snow = hit.shown().getMaterial() == Material.SNOW;
        for (Player other : Bukkit.getOnlinePlayers()) {
            Seen theirs = seen.get(other.getUniqueId());
            if (theirs == null || !one.world.equals(theirs.world)) continue;
            drop(other, theirs, block.getX(), block.getY(), block.getZ());
            if (snow) drop(other, theirs, block.getX(), block.getY() - 1, block.getZ());
        }
        return hit.shown();
    }

    /** The decoration a player is shown at a block, or null - and null for a real block only drawn differently. */
    private Fake shownAt(Player player, Block block) {
        Seen one = seen.get(player.getUniqueId());
        if (one == null || !player.getWorld().getUID().equals(one.world)) return null;
        List<Fake> fakes = one.chunks.get(chunkKey(block.getX() >> 4, block.getZ() >> 4));
        if (fakes == null) return null;
        Fake hit = null;
        for (Fake fake : fakes) if (same(fake.at(), block.getX(), block.getY(), block.getZ())) hit = fake;
        return hit == null || redrawn(hit) ? null : hit;
    }

    /** A real block only drawn in another state of itself, as grass drawn snowy. */
    private static boolean redrawn(Fake fake) {
        return fake.shown().getMaterial() == fake.real().getMaterial();
    }

    private static boolean same(Location at, int x, int y, int z) {
        return at.getBlockX() == x && at.getBlockY() == y && at.getBlockZ() == z;
    }

    private static void drop(Player player, Seen one, int x, int y, int z) {
        long key = chunkKey(x >> 4, z >> 4);
        List<Fake> fakes = one.chunks.get(key);
        if (fakes == null) return;
        List<Fake> kept = new ArrayList<>(fakes.size());
        for (Fake fake : fakes) {
            if (same(fake.at(), x, y, z)) restore(player, one, fake);
            else kept.add(fake);
        }
        if (kept.size() != fakes.size()) one.chunks.put(key, kept);
    }

    /**
     * Every hit on a decoration is called off, so the real block under it stays
     * as it is and drops nothing. Left to the game, the hit broke that real block
     * instead (a hole, and dirt), or nothing at all where the decoration stood in
     * air, and the decoration stood there again the next time its chunk was
     * decided.
     *
     * A pumpkin is dug like a real one: Bukkit tells only of the first hit, so
     * the dig goes on while the player keeps swinging at it ({@link #onSwing})
     * and it comes down, dropping itself, once as long has gone as the tool in
     * hand takes ({@link #dig}). One dug in a single hit, or hit by a player in
     * creative, comes down on that hit. Anything else comes down on the first
     * hit, as before.
     */
    @EventHandler
    public void onHit(PlayerInteractEvent event) {
        if (season == null || event.getAction() != Action.LEFT_CLICK_BLOCK || event.getClickedBlock() == null) return;
        Player player = event.getPlayer();
        Block block = event.getClickedBlock();
        Fake hit = shownAt(player, block);
        if (hit == null) return;
        event.setCancelled(true);
        BlockData shown = hit.shown();
        boolean creative = player.getGameMode() == GameMode.CREATIVE;
        if (!pumpkin(shown) || creative) {
            knockDown(player, block, shown, !creative);
            return;
        }
        double hardness = Math.max(0.05, shown.getMaterial().getHardness());
        double perTick = toolSpeed(shown, player.getInventory().getItemInMainHand()) / hardness / DIG_DIVISOR;
        if (perTick >= 1) {
            knockDown(player, block, shown, true);
            return;
        }
        digs.put(player.getUniqueId(), new Dig(block, shown, ticks, perTick));
        // The hit called off may have put the real block back on their screen.
        Bukkit.getScheduler().runTask(plugin, () -> {
            if (shownAt(player, block) != null) player.sendBlockChange(block.getLocation(), shown);
        });
    }

    /** Swinging on at the pumpkin being dug keeps the dig going. */
    @EventHandler
    public void onSwing(PlayerAnimationEvent event) {
        if (event.getAnimationType() != PlayerAnimationType.ARM_SWING) return;
        Dig dig = digs.get(event.getPlayer().getUniqueId());
        if (dig == null) return;
        Block target = event.getPlayer().getTargetBlockExact(6);
        if (target != null && target.equals(dig.block)) dig.swung = ticks;
    }

    /** Each tick: a dig left off ends, and a dig long enough brings its pumpkin down. */
    private void dig() {
        if (digs.isEmpty()) return;
        digs.entrySet().removeIf(entry -> {
            Dig dig = entry.getValue();
            Player player = Bukkit.getPlayer(entry.getKey());
            if (player == null || ticks - dig.swung > DIG_IDLE_TICKS) return true;
            if ((ticks - dig.since + 1) * dig.perTick < 1) return false;
            knockDown(player, dig.block, dig.shown, true);
            return true;
        });
    }

    /** Down for everybody; a pumpkin dug out drops itself, and may be a trap. */
    private void knockDown(Player player, Block block, BlockData shown, boolean dug) {
        if (takeDown(player, block) == null || !pumpkin(shown)) return;
        if (dug) block.getWorld().dropItemNaturally(block.getLocation().add(0, 1, 0), new ItemStack(shown.getMaterial()));
        pumpkinTaken.accept(player, block);
    }

    /**
     * How fast a tool digs a block, as the game sums it: the tier of the tool
     * the block wants, then efficiency. Bukkit has no sum for a block that is
     * not there; haste and the like are left out.
     */
    private static double toolSpeed(BlockData shown, ItemStack hand) {
        if (hand == null || !shown.isPreferredTool(hand)) return 1;
        String name = hand.getType().name();
        double speed = name.startsWith("WOODEN_") ? 2
                : name.startsWith("STONE_") ? 4
                : name.startsWith("IRON_") ? 6
                : name.startsWith("DIAMOND_") ? 8
                : name.startsWith("NETHERITE_") ? 9
                : name.startsWith("GOLDEN_") ? 12
                : 1;
        int efficiency = hand.getEnchantmentLevel(Enchantment.EFFICIENCY);
        return speed > 1 && efficiency > 0 ? speed + efficiency * efficiency + 1 : speed;
    }

    private static boolean pumpkin(BlockData shown) {
        Material kind = shown.getMaterial();
        return kind == Material.PUMPKIN || kind == Material.CARVED_PUMPKIN || kind == Material.JACK_O_LANTERN;
    }

    /** The broken list for this season, read from beside the world the first time. */
    private void keepBroken(Season next) {
        if (brokenFile == null && !Bukkit.getWorlds().isEmpty()) {
            brokenFile = Bukkit.getWorlds().get(0).getWorldFolder().toPath().resolve(BROKEN_FILE);
            try {
                broken = BrokenDecor.read(brokenFile);
            } catch (IOException unreadable) {
                plugin.getLogger().warning("Polaris could not read " + brokenFile + "; decorations broken before come back: " + unreadable);
            }
        }
        if (broken.keepFor(next.name().toLowerCase(Locale.ROOT), System.currentTimeMillis())) writeBroken();
    }

    private void flushBroken() {
        if (brokenDirty) writeBroken();
    }

    private void writeBroken() {
        brokenDirty = false;
        if (brokenFile == null) return;
        try {
            broken.write(brokenFile);
        } catch (IOException failed) {
            plugin.getLogger().warning("Polaris could not write " + brokenFile + ": " + failed);
        }
    }

    /** Whether a decoration was knocked down: itself, or the ground drawn snowy under thin snow that was. */
    private boolean wasBroken(Fake fake) {
        Location at = fake.at();
        if (broken.contains(blockKey(at.getBlockX(), at.getBlockY(), at.getBlockZ()))) return true;
        return redrawn(fake) && broken.contains(blockKey(at.getBlockX(), at.getBlockY() + 1, at.getBlockZ()));
    }

    /** A block position in one long, laid out as the game's own. */
    private static long blockKey(int x, int y, int z) {
        return ((long) x & 0x3FFFFFFL) << 38 | ((long) z & 0x3FFFFFFL) << 12 | (long) y & 0xFFFL;
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
                for (Fake fake : fakes) if (!web(fake)) restore(player, one, fake);
            }
        }
        for (Seen one : seen.values()) removeWebs(one);
        seen.clear();
        digs.clear();
    }

    private static boolean web(Fake fake) {
        return fake.shown().getMaterial() == Material.COBWEB;
    }

    /** Draw a decoration on one player's screen: a block change, or for a cobweb its display. */
    private void show(Player player, Seen one, Fake fake) {
        if (web(fake)) showWeb(player, one, fake);
        else player.sendBlockChange(fake.at(), fake.shown());
    }

    /** The block as it really is now, which is what the player's game shows after; a cobweb's display is taken away. */
    private static void restore(Player player, Seen one, Fake fake) {
        Location at = fake.at();
        if (!web(fake)) {
            player.sendBlockChange(at, at.getBlock().getBlockData());
            return;
        }
        BlockDisplay display = one.webs.remove(blockKey(at.getBlockX(), at.getBlockY(), at.getBlockZ()));
        if (display != null) display.remove();
    }

    /**
     * A cobweb as a block display shown to this player alone: nothing collides
     * with it, so nobody is slowed by a web the server does not have, and it stays
     * in sight up close. Bukkit has no entity that lives only on one player's
     * screen, so it is a real one, hidden from everybody else and never saved
     * with the world; one whose chunk was unloaded is gone, and is spawned again
     * the next time it is shown.
     */
    private void showWeb(Player player, Seen one, Fake fake) {
        Location at = fake.at();
        long key = blockKey(at.getBlockX(), at.getBlockY(), at.getBlockZ());
        BlockDisplay display = one.webs.get(key);
        if (display != null && display.isValid()) return;
        World world = at.getWorld();
        if (world == null || !world.isChunkLoaded(at.getBlockX() >> 4, at.getBlockZ() >> 4)) return;
        display = world.spawn(at, BlockDisplay.class, spawned -> {
            spawned.setVisibleByDefault(false);
            spawned.setPersistent(false);
            spawned.setBlock(fake.shown());
        });
        player.showEntity(plugin, display);
        one.webs.put(key, display);
    }

    private static void removeWebs(Seen one) {
        for (BlockDisplay display : one.webs.values()) display.remove();
        one.webs.clear();
    }

    /**
     * Pick block (middle click) on a block, from {@code SeasonalDecorPick}: true
     * when the player picked a decoration and it is answered here. A cobweb is a
     * display their game looks through, so its pick names the block behind it; a
     * web on the line of sight nearer than that block is what they meant. Handed
     * out as the game hands out a pick: selected where it already is in the
     * inventory, and in creative put in the hotbar when it is not.
     */
    boolean pick(Player player, Block block) {
        if (season == null) return false;
        Fake hit = shownAt(player, block);
        if (hit == null) hit = webInSight(player, block);
        if (hit == null) return false;
        Material kind = hit.shown().getMaterial();
        if (!kind.isItem()) return true;
        ItemStack item = new ItemStack(kind);
        PlayerInventory inventory = player.getInventory();
        int slot = -1;
        for (int i = 0; i < 36 && slot == -1; i++) {
            ItemStack there = inventory.getItem(i);
            if (there != null && there.isSimilar(item)) slot = i;
        }
        if (slot >= 0 && slot < 9) {
            inventory.setHeldItemSlot(slot);
        } else if (slot >= 9) {
            int hotbar = pickSlot(inventory);
            ItemStack held = inventory.getItem(hotbar);
            inventory.setItem(hotbar, inventory.getItem(slot));
            inventory.setItem(slot, held);
            inventory.setHeldItemSlot(hotbar);
        } else if (player.getGameMode() == GameMode.CREATIVE) {
            int hotbar = pickSlot(inventory);
            ItemStack held = inventory.getItem(hotbar);
            if (held != null && !held.getType().isAir()) {
                int free = inventory.firstEmpty();
                if (free != -1) inventory.setItem(free, held);
            }
            inventory.setItem(hotbar, item);
            inventory.setHeldItemSlot(hotbar);
        }
        return true;
    }

    /** The hotbar slot a pick goes to, as the game chooses it: an empty one, else one not enchanted, from the selected one on. */
    private static int pickSlot(PlayerInventory inventory) {
        int selected = inventory.getHeldItemSlot();
        for (int i = 0; i < 9; i++) {
            ItemStack there = inventory.getItem((selected + i) % 9);
            if (there == null || there.getType().isAir()) return (selected + i) % 9;
        }
        for (int i = 0; i < 9; i++) {
            ItemStack there = inventory.getItem((selected + i) % 9);
            if (there == null || there.getEnchantments().isEmpty()) return (selected + i) % 9;
        }
        return selected;
    }

    /** The nearest cobweb a player is shown on their line of sight, before the block their game picked, or null. */
    private Fake webInSight(Player player, Block picked) {
        Seen one = seen.get(player.getUniqueId());
        if (one == null || one.webs.isEmpty() || !player.getWorld().getUID().equals(one.world)) return null;
        Location eye = player.getEyeLocation();
        Vector from = eye.toVector();
        Vector direction = eye.getDirection();
        double nearest = distance(BoundingBox.of(picked), from, direction);
        int atX = eye.getBlockX() >> 4;
        int atZ = eye.getBlockZ() >> 4;
        Fake web = null;
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                List<Fake> fakes = one.chunks.get(chunkKey(atX + dx, atZ + dz));
                if (fakes == null) continue;
                for (Fake fake : fakes) {
                    if (!web(fake)) continue;
                    double distance = distance(BoundingBox.of(fake.at().getBlock()), from, direction);
                    if (distance < nearest) {
                        nearest = distance;
                        web = fake;
                    }
                }
            }
        }
        return web;
    }

    private static double distance(BoundingBox box, Vector from, Vector direction) {
        RayTraceResult hit = box.rayTrace(from, direction, PICK_REACH);
        return hit == null ? Double.MAX_VALUE : hit.getHitPosition().distanceSquared(from);
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
