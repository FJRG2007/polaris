package polaris.minecraft;

import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.HeightMap;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.entity.AbstractSkeleton;
import org.bukkit.entity.Entity;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Monster;
import org.bukkit.entity.Phantom;
import org.bukkit.entity.Player;
import org.bukkit.entity.Snowman;
import org.bukkit.entity.Zombie;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.EntityBlockFormEvent;
import org.bukkit.event.entity.CreatureSpawnEvent;
import org.bukkit.event.world.EntitiesLoadEvent;
import org.bukkit.inventory.EntityEquipment;
import org.bukkit.inventory.ItemStack;

/**
 * The season's mobs, alongside {@link SeasonalDecor}'s decorations - the same as
 * the NeoForge mod's {@code SeasonalMobs}, through Bukkit.
 *
 * Halloween: a zombie or skeleton that spawns at night in the overworld wears a
 * carved pumpkin or a jack o'lantern, which it never drops and which comes off
 * at sunrise (a head item would otherwise keep it from burning). With a spawn
 * setting over 100%, each natural night spawn of a monster may bring another of
 * its kind to the same spot, a little later and never past a crowd.
 *
 * Winter: snow golems turn up near players standing somewhere cold enough to
 * snow, some still wearing their pumpkin. They leave no snow behind them, go
 * when nobody is near, and are gone when the winter is.
 *
 * Every mob this adds or dresses carries a scoreboard tag, so the season ending,
 * the setting going to none, or a chunk loaded out of season puts it all back:
 * the pumpkins come off and the golems leave. Nothing else in the world is
 * touched.
 *
 * Main thread only: the command, the events and the timer all run there.
 */
final class SeasonalMobs implements Listener {
    /** The spawn setting that adds nothing, and the most either setting takes, in percent. */
    static final int USUAL = 100;
    static final int MAX_PERCENT = 400;

    static final String HEAD_TAG = "polaris_season_head";
    static final String GOLEM_TAG = "polaris_season_golem";

    private static final int HEAD_CHANCE = 75;
    private static final int LIT_CHANCE = 35;
    /** What a mob's armour drops at when nothing set it otherwise. */
    private static final float USUAL_DROP_CHANCE = 0.085f;

    private static final int EXTRA_QUEUE = 64;
    private static final int EXTRA_PER_TICK = 4;
    private static final int CROWD = 24;
    private static final double CROWD_RADIUS = 32;
    private static final double PLAYER_CLEARANCE = 24;

    private static final int GOLEMS_NEAR = 2;
    private static final double GOLEM_NEAR_RADIUS = 48;
    private static final int GOLEM_MIN_DISTANCE = 14;
    private static final int GOLEM_MAX_DISTANCE = 30;
    private static final double GOLEM_LEAVE_DISTANCE = 96;
    private static final int GOLEM_ODDS = 4;
    private static final int GOLEM_PUMPKIN_CHANCE = 40;
    /** Below this a biome's temperature snows rather than rains. */
    private static final double SNOW_TEMPERATURE = 0.15;

    private static final int SWEEP_TICKS = 200;

    private record Extra(UUID world, EntityType type, Location at) {}

    private final SeasonalDecor decor;
    private final Random random = new Random();
    private final ArrayDeque<Extra> extras = new ArrayDeque<>();
    private int spawns = USUAL;
    private int golems;
    private int ticks;

    SeasonalMobs(SeasonalDecor decor) {
        this.decor = decor;
    }

    // ------------------------------------------------------------------ commands

    /** The settings that came with {@code polaris season set}. */
    void configure(int spawnPercent, int golemPercent) {
        spawns = Math.min(Math.max(spawnPercent, USUAL), MAX_PERCENT);
        golems = Math.min(Math.max(golemPercent, 0), MAX_PERCENT);
        if (spawns <= USUAL) extras.clear();
        if (golems == 0) sendGolemsAway(true);
    }

    /** Everything this added or dressed, put back: the season ended or changed. */
    void revert() {
        for (World world : Bukkit.getWorlds()) {
            for (Entity entity : tagged(world)) {
                if (entity.getScoreboardTags().contains(GOLEM_TAG)) entity.remove();
                else if (entity instanceof LivingEntity living) takeHeadOff(living);
            }
        }
        forget();
    }

    /** Back to nothing without touching the world. */
    void forget() {
        spawns = USUAL;
        golems = 0;
        extras.clear();
    }

    void status(JsonObject reply) {
        reply.addProperty("spawnPercent", spawns);
        reply.addProperty("golemPercent", golems);
        reply.addProperty("extrasWaiting", extras.size());
    }

    // ------------------------------------------------------------------ events

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onSpawn(CreatureSpawnEvent event) {
        if (decor.season() != SeasonalDecor.Season.HALLOWEEN) return;
        if (event.getSpawnReason() != CreatureSpawnEvent.SpawnReason.NATURAL) return;
        LivingEntity mob = event.getEntity();
        World world = mob.getWorld();
        if (world.getEnvironment() != World.Environment.NORMAL || !night(world)) return;
        if (wearsHeads(mob) && bareHead(mob) && random.nextInt(100) < HEAD_CHANCE) putHeadOn(mob);
        if (spawns <= USUAL || !bringsExtras(mob)) return;
        int more = (spawns - USUAL) / 100;
        if (random.nextInt(100) < (spawns - USUAL) % 100) more++;
        for (int i = 0; i < more && extras.size() < EXTRA_QUEUE; i++) {
            extras.addLast(new Extra(world.getUID(), mob.getType(), event.getLocation().clone()));
        }
    }

    /** A seasonal golem leaves no snow trail: the ground stays as it was. */
    @EventHandler(ignoreCancelled = true)
    public void onForm(EntityBlockFormEvent event) {
        if (event.getEntity() instanceof Snowman golem && golem.getScoreboardTags().contains(GOLEM_TAG))
            event.setCancelled(true);
    }

    /** A chunk loaded after the season ended, or by day, brings back nothing of it. */
    @EventHandler
    public void onLoad(EntitiesLoadEvent event) {
        for (Entity entity : event.getEntities()) {
            if (entity.getScoreboardTags().contains(GOLEM_TAG)) {
                if (decor.season() != SeasonalDecor.Season.WINTER || golems == 0) entity.remove();
            } else if (entity instanceof LivingEntity living && entity.getScoreboardTags().contains(HEAD_TAG)) {
                if (decor.season() != SeasonalDecor.Season.HALLOWEEN || !night(entity.getWorld())) takeHeadOff(living);
            }
        }
    }

    /** Every tick while a season is on, from {@link SeasonalDecor}'s timer. */
    void tick() {
        ticks++;
        placeExtras();
        if (ticks % SWEEP_TICKS == 0) sweep();
    }

    // ------------------------------------------------------------------ Halloween

    /** Night as the overworld's clock tells it, as the decorations' night touches use. */
    private static boolean night(World world) {
        long time = world.getTime();
        return time >= 13_000 && time <= 23_000;
    }

    private static boolean wearsHeads(LivingEntity mob) {
        return mob instanceof Zombie || mob instanceof AbstractSkeleton;
    }

    private static boolean bringsExtras(LivingEntity mob) {
        return mob instanceof Monster && !(mob instanceof Phantom);
    }

    private static boolean bareHead(LivingEntity mob) {
        EntityEquipment equipment = mob.getEquipment();
        if (equipment == null) return false;
        ItemStack head = equipment.getHelmet();
        return head == null || head.getType().isAir();
    }

    private void putHeadOn(LivingEntity mob) {
        EntityEquipment equipment = mob.getEquipment();
        if (equipment == null) return;
        boolean lit = random.nextInt(100) < LIT_CHANCE;
        equipment.setHelmet(new ItemStack(lit ? Material.JACK_O_LANTERN : Material.CARVED_PUMPKIN));
        // Never dropped, so the season leaves nothing behind in anybody's chest.
        equipment.setHelmetDropChance(0f);
        mob.addScoreboardTag(HEAD_TAG);
    }

    /** The seasonal pumpkin off, if it is still the one on: a helmet it picked up since stays. */
    private static void takeHeadOff(LivingEntity mob) {
        EntityEquipment equipment = mob.getEquipment();
        if (equipment != null) {
            ItemStack head = equipment.getHelmet();
            Material type = head == null ? Material.AIR : head.getType();
            if (type == Material.CARVED_PUMPKIN || type == Material.JACK_O_LANTERN) {
                equipment.setHelmet(null);
                equipment.setHelmetDropChance(USUAL_DROP_CHANCE);
            }
        }
        mob.removeScoreboardTag(HEAD_TAG);
    }

    private void placeExtras() {
        for (int placed = 0; placed < EXTRA_PER_TICK && !extras.isEmpty(); placed++) {
            Extra extra = extras.removeFirst();
            if (decor.season() != SeasonalDecor.Season.HALLOWEEN) {
                extras.clear();
                return;
            }
            World world = Bukkit.getWorld(extra.world());
            Location at = extra.at();
            if (world == null || !night(world)) continue;
            if (!world.isChunkLoaded(at.getBlockX() >> 4, at.getBlockZ() >> 4)) continue;
            Block feet = world.getBlockAt(at);
            if (!feet.isPassable() || !feet.getRelative(BlockFace.UP).isPassable()) continue;
            if (!world.getNearbyEntities(at, PLAYER_CLEARANCE, PLAYER_CLEARANCE, PLAYER_CLEARANCE,
                    entity -> entity instanceof Player).isEmpty()) continue;
            if (world.getNearbyEntities(at, CROWD_RADIUS, CROWD_RADIUS, CROWD_RADIUS,
                    entity -> entity instanceof Monster).size() >= CROWD) continue;
            Location spot = at.clone();
            spot.setWorld(world);
            Entity spawned = world.spawnEntity(spot, extra.type());
            // Spawned as custom, so it brings no extra of its own; it dresses as a natural one would.
            if (spawned instanceof LivingEntity mob && wearsHeads(mob) && bareHead(mob)
                    && random.nextInt(100) < HEAD_CHANCE) {
                putHeadOn(mob);
            }
        }
    }

    // ------------------------------------------------------------------ the sweep

    private void sweep() {
        boolean halloween = decor.season() == SeasonalDecor.Season.HALLOWEEN;
        for (World world : Bukkit.getWorlds()) {
            if (halloween && night(world)) continue;
            for (Entity entity : tagged(world)) {
                if (entity instanceof LivingEntity living && entity.getScoreboardTags().contains(HEAD_TAG))
                    takeHeadOff(living);
            }
        }
        boolean winter = decor.season() == SeasonalDecor.Season.WINTER && golems > 0;
        sendGolemsAway(!winter);
        if (!winter) return;
        int cap = Math.max(1, Math.round(GOLEMS_NEAR * golems / 100f));
        for (Player player : Bukkit.getOnlinePlayers()) {
            World world = player.getWorld();
            if (world.getEnvironment() != World.Environment.NORMAL || player.getGameMode() == GameMode.SPECTATOR) continue;
            Location at = player.getLocation();
            if (!cold(at.getBlock())) continue;
            int near = world.getNearbyEntities(at, GOLEM_NEAR_RADIUS, GOLEM_NEAR_RADIUS, GOLEM_NEAR_RADIUS,
                    entity -> entity instanceof Snowman && entity.getScoreboardTags().contains(GOLEM_TAG)).size();
            if (near >= cap || random.nextInt(GOLEM_ODDS) != 0) continue;
            Block feet = golemSpot(world, at);
            if (feet != null) bringGolem(world, feet);
        }
    }

    /** Golems with nobody near leave, or every one of them with {@code all}. */
    private void sendGolemsAway(boolean all) {
        for (World world : Bukkit.getWorlds()) {
            for (Entity entity : tagged(world)) {
                if (!entity.getScoreboardTags().contains(GOLEM_TAG)) continue;
                if (all || world.getNearbyEntities(entity.getLocation(), GOLEM_LEAVE_DISTANCE, GOLEM_LEAVE_DISTANCE,
                        GOLEM_LEAVE_DISTANCE, other -> other instanceof Player).isEmpty()) {
                    entity.remove();
                }
            }
        }
    }

    private static boolean cold(Block block) {
        return block.getTemperature() < SNOW_TEMPERATURE;
    }

    /** Somewhere cold, open and natural a little way off, or null. */
    private Block golemSpot(World world, Location around) {
        for (int tries = 0; tries < 6; tries++) {
            double angle = random.nextDouble() * Math.PI * 2;
            int distance = GOLEM_MIN_DISTANCE + random.nextInt(GOLEM_MAX_DISTANCE - GOLEM_MIN_DISTANCE + 1);
            int x = around.getBlockX() + (int) Math.round(Math.cos(angle) * distance);
            int z = around.getBlockZ() + (int) Math.round(Math.sin(angle) * distance);
            if (!world.isChunkLoaded(x >> 4, z >> 4)) continue;
            Block ground = world.getHighestBlockAt(x, z, HeightMap.MOTION_BLOCKING_NO_LEAVES);
            Block feet = ground.getRelative(BlockFace.UP);
            Material under = ground.getType();
            boolean naturalGround = under == Material.SNOW_BLOCK
                    || (SeasonalDecor.natural(ground) && !under.isAir() && !Tag.LEAVES.isTagged(under));
            if (!naturalGround || !under.isSolid()) continue;
            if (!(feet.getType().isAir() || feet.getType() == Material.SNOW)) continue;
            if (!feet.getRelative(BlockFace.UP).getType().isAir() || !cold(feet)) continue;
            return feet;
        }
        return null;
    }

    private void bringGolem(World world, Block feet) {
        boolean pumpkin = random.nextInt(100) < GOLEM_PUMPKIN_CHANCE;
        Location at = feet.getLocation().add(0.5, 0, 0.5);
        at.setYaw(random.nextFloat() * 360f);
        world.spawn(at, Snowman.class, golem -> {
            golem.setDerp(!pumpkin);
            golem.addScoreboardTag(GOLEM_TAG);
        });
    }

    /** The loaded entities carrying either seasonal tag, gathered first so they can be changed. */
    private static List<Entity> tagged(World world) {
        List<Entity> found = new ArrayList<>();
        for (Entity entity : world.getEntities()) {
            if (entity.getScoreboardTags().contains(HEAD_TAG) || entity.getScoreboardTags().contains(GOLEM_TAG))
                found.add(entity);
        }
        return found;
    }
}
