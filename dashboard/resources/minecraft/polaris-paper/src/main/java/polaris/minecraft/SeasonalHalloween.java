package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import net.md_5.bungee.api.ChatMessageType;
import net.md_5.bungee.api.chat.TextComponent;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Color;
import org.bukkit.GameMode;
import org.bukkit.HeightMap;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.Particle;
import org.bukkit.Registry;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.Chest;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Directional;
import org.bukkit.entity.Bat;
import org.bukkit.entity.Entity;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Monster;
import org.bukkit.entity.Phantom;
import org.bukkit.entity.Player;
import org.bukkit.entity.Skeleton;
import org.bukkit.entity.SkeletonHorse;
import org.bukkit.entity.Villager;
import org.bukkit.entity.Witch;
import org.bukkit.entity.Zombie;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.CreatureSpawnEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.world.EntitiesLoadEvent;
import org.bukkit.inventory.EntityEquipment;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.Plugin;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;
import org.bukkit.scheduler.BukkitTask;

/**
 * Halloween's extra touches, as the NeoForge mod's {@code SeasonalHalloween}
 * draws them: witches, bats at dusk, treats, the headless horseman, trap
 * pumpkins, one blood night, a trick-or-treat villager, phantoms and graves.
 * The dashboard switches each one with {@code polaris season halloween
 * key=value ...} ({@link HalloweenSettings}); all of them wait for the season
 * to be Halloween, and every cap is the mod's.
 *
 * Every mob this adds carries {@link #TAG}: it never comes back from disk, and
 * the season ending takes it away. Graveyards are written down in the main
 * world's folder with the moment the dashboard says the season ends, and come
 * down only once it has passed - not on a restart, nor while an event pauses
 * the season; a chest somebody filled with their own things is left standing.
 */
final class SeasonalHalloween implements Listener {
    static final String TAG = "polaris_halloween";
    private static final String HORSEMAN_TAG = "polaris_halloween_horseman";
    private static final String TRICK_TAG = "polaris_halloween_trick";

    private static final int SWEEP_TICKS = 100;
    private static final int FOG_TICKS = 10;
    private static final int WITCH_BASE = 6;
    private static final int BATS_PER_SWARM = 5;
    private static final int MAX_SWARM = 12;
    private static final int MAX_BATS = 64;
    private static final int BAT_LIFE = 1200;
    private static final int TRAP_BAT_LIFE = 600;
    private static final int TREAT_CHANCE = 8;
    private static final int HORSEMAN_ODDS = 300;
    private static final int TRAP_BASE = 15;
    private static final int TRAP_COOLDOWN = 200;
    private static final int TRICK_ODDS = 60;
    private static final double TRICK_NEAR = 64;
    private static final int MAX_TRICKS = 4;
    private static final int TRICK_TREATS = 3;
    private static final int TRICK_LIFE = 6000;
    private static final int TRICK_SCARE_CHANCE = 30;
    private static final int PHANTOM_ODDS = 8;
    private static final int PHANTOMS_NEAR = 2;
    private static final int MAX_PHANTOMS = 16;
    private static final double PHANTOM_DAMAGE = 0.5;
    private static final int GRAVEYARDS = 4;
    private static final int GRAVE_SPACING = 128;
    private static final int GRAVE_MIN_DISTANCE = 40;
    private static final int GRAVE_MAX_DISTANCE = 72;
    private static final int GRAVE_EVERY = 6000;
    private static final int GRAVE_CLEAR_RADIUS = 14;
    private static final int GRAVE_CLEAR_HEIGHT = 4;
    private static final String STATE_FILE = "polaris-halloween.json";
    private static final Material[] STONES = {Material.MOSSY_COBBLESTONE_WALL, Material.COBBLESTONE_WALL, Material.STONE_BRICK_WALL};

    /** The stones of one graveyard, its chest, and what was put in it; positions packed as the mod packs them. */
    private record Graveyard(List<Long> stones, long chest, Map<String, Integer> loot) {}

    private final Plugin plugin;
    private final SeasonalDecor decor;
    private final Random random = new Random();
    private HalloweenSettings settings = HalloweenSettings.OFF;
    private BukkitTask timer;
    private boolean wasOn;
    private int ticks;
    private boolean loaded;
    private Path stateFile;
    private final List<Graveyard> graveyards = new ArrayList<>();
    private int bloodDone;
    /** When the dashboard last said the season ends, in epoch millis; 0 until told. */
    private long seasonEndsMillis;
    private boolean bloodActive;
    private long horsemanNight = -1;
    /** The night's visitors still about, counted once a sweep and as each comes. */
    private int phantomsAlive;
    private int tricksAlive;
    private boolean horsemanAlive;
    private int lastGraveTick = -GRAVE_EVERY;
    private final Map<UUID, Long> swarmedDusk = new HashMap<>();
    private final Map<UUID, Integer> trapAt = new HashMap<>();
    private final Map<UUID, Integer> treatsGiven = new HashMap<>();

    SeasonalHalloween(Plugin plugin, SeasonalDecor decor) {
        this.plugin = plugin;
        this.decor = decor;
        decor.onPumpkinTaken(this::trap);
    }

    void start() {
        if (timer == null) timer = Bukkit.getScheduler().runTaskTimer(plugin, this::tick, 1, 1);
    }

    void stop() {
        if (timer != null) timer.cancel();
        timer = null;
    }

    // ------------------------------------------------------------------ commands

    /** {@code polaris season halloween key=value ...}. */
    JsonObject configure(String[] words) {
        HalloweenSettings next = HalloweenSettings.parse(words);
        if (next == null) return SoundPack.refused("usage");
        if (!loaded) load();
        settings = next;
        if (next.secondsLeft() > 0) {
            long ends = System.currentTimeMillis() + next.secondsLeft() * 1000L;
            boolean moved = Math.abs(ends - seasonEndsMillis) > 60_000;
            seasonEndsMillis = ends;
            if (moved) save();
        } else if (next.gravePercent() == 0) {
            // Switched off, not paused: no season left to keep the graveyards for, so
            // they come down now and, where a chunk is not loaded, on a later pass.
            if (seasonEndsMillis != 0) {
                seasonEndsMillis = 0;
                save();
            }
            takeGraveyardsDown();
        }
        return status();
    }

    private JsonObject status() {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("halloween", halloween());
        reply.addProperty("bloodNight", bloodActive);
        reply.addProperty("bloodDone", bloodDone);
        reply.addProperty("graveyards", graveyards.size());
        return reply;
    }

    private boolean halloween() {
        return decor.season() == SeasonalDecor.Season.HALLOWEEN;
    }

    // ------------------------------------------------------------------ the timer

    private void tick() {
        try {
            ticks++;
            if (!loaded) load();
            boolean on = halloween();
            if (on != wasOn) {
                if (!on) endSeason();
                wasOn = on;
            }
            if (!on) {
                if (!graveyards.isEmpty() && ticks % SWEEP_TICKS == 0 && seasonOver()) takeGraveyardsDown();
                return;
            }
            if (bloodActive && ticks % FOG_TICKS == 0) fog();
            if (ticks % SWEEP_TICKS == 0) sweep();
        } catch (RuntimeException failed) {
            // A tick must never fail over Halloween: everything is off until told again.
            plugin.getLogger().severe("Polaris Halloween extras failed and are off until told again: " + failed);
            settings = HalloweenSettings.OFF;
            bloodActive = false;
        }
    }

    private static World overworld() {
        List<World> worlds = Bukkit.getWorlds();
        return worlds.isEmpty() ? null : worlds.get(0);
    }

    private void endSeason() {
        for (World world : Bukkit.getWorlds()) for (Entity entity : tagged(world)) entity.remove();
        if (bloodActive) endBloodNight();
        swarmedDusk.clear();
        trapAt.clear();
        treatsGiven.clear();
    }

    /** The season's end the dashboard gave has passed, or it never gave one. */
    private boolean seasonOver() {
        return seasonEndsMillis == 0 || System.currentTimeMillis() >= seasonEndsMillis;
    }

    private void sweep() {
        World world = overworld();
        if (world == null) return;
        long time = world.getTime();
        boolean night = time >= 13_000 && time <= 23_000;
        boolean dusk = time >= 11_800 && time < 13_000;
        tidy(world, night);
        bloodNight(world, night);
        List<Player> outside = new ArrayList<>();
        for (Player player : world.getPlayers()) {
            if (player.getGameMode() == GameMode.SPECTATOR) continue;
            Location eye = player.getEyeLocation();
            if (world.getHighestBlockYAt(eye.getBlockX(), eye.getBlockZ()) < eye.getBlockY()) outside.add(player);
        }
        if (dusk && settings.batPercent() > 0) for (Player player : outside) swarm(world, player);
        if (night && settings.phantoms()) for (Player player : outside) phantom(world, player);
        if (night && settings.trickOrTreat()) for (Player player : outside) trickOrTreater(world, player);
        if (night && settings.horseman() && !outside.isEmpty()) horseman(world, outside);
        if (settings.gravePercent() > 0 && !outside.isEmpty()) graveyard(world, outside);
        else if (settings.gravePercent() == 0 && !graveyards.isEmpty()) takeGraveyardsDown();
    }

    /** What has had its time goes: bats after a minute, the night's visitors at dawn. */
    private void tidy(World world, boolean night) {
        List<Entity> mine = tagged(world);
        for (Entity entity : mine) {
            if (entity instanceof Bat) {
                if (entity.getTicksLived() > BAT_LIFE) entity.remove();
            } else if (entity instanceof Villager villager) {
                Integer given = treatsGiven.get(villager.getUniqueId());
                boolean done = given != null && given >= TRICK_TREATS;
                if (!night || done || villager.getTicksLived() > TRICK_LIFE || !settings.trickOrTreat()
                        || nearby(world, villager.getLocation(), TRICK_NEAR, Player.class) == 0) {
                    world.spawnParticle(Particle.LARGE_SMOKE, villager.getLocation().add(0, 1, 0), 12, 0.3, 0.5, 0.3, 0.02);
                    treatsGiven.remove(villager.getUniqueId());
                    villager.remove();
                }
            } else if (entity instanceof SkeletonHorse horse) {
                // Its rider fell: the horse is the player's to keep, an ordinary one from now on.
                if (horse.getPassengers().isEmpty()) {
                    horse.removeScoreboardTag(TAG);
                    horse.removeScoreboardTag(HORSEMAN_TAG);
                } else if (!night) {
                    for (Entity rider : horse.getPassengers()) rider.remove();
                    horse.remove();
                }
            } else if (!night || entity instanceof Phantom && !settings.phantoms()) {
                entity.remove();
            }
        }
        phantomsAlive = 0;
        tricksAlive = 0;
        horsemanAlive = false;
        for (Entity entity : mine) {
            if (!entity.isValid()) continue;
            if (entity instanceof Phantom) phantomsAlive++;
            else if (entity instanceof Villager) tricksAlive++;
            else if (entity.getScoreboardTags().contains(HORSEMAN_TAG)) horsemanAlive = true;
        }
    }

    // ------------------------------------------------------------------ spawns and drops

    /** Witches and the blood night's second spawns, for a spawn every other plugin let through. */
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onSpawned(CreatureSpawnEvent event) {
        if (!halloween() || event.getSpawnReason() != CreatureSpawnEvent.SpawnReason.NATURAL) return;
        LivingEntity mob = event.getEntity();
        World world = mob.getWorld();
        if (!(mob instanceof Monster) || mob instanceof Phantom || mob instanceof Witch) return;
        SeasonalMobs mobs = decor.mobs();
        // The Nether and the End have no night of their own: the blood night is
        // the overworld's, and it doubles their spawns too. Witches stay at home.
        if (world.getEnvironment() != World.Environment.NORMAL) {
            if (bloodActive) mobs.queueExtra(world, mob.getType(), event.getLocation());
            return;
        }
        long time = world.getTime();
        if (time < 13_000 || time > 23_000) return;
        if (settings.witchPercent() > 0 && random.nextInt(100 * 100) < WITCH_BASE * settings.witchPercent()) {
            mobs.queueExtra(world, EntityType.WITCH, event.getLocation());
        }
        if (bloodActive) mobs.queueExtra(world, mob.getType(), event.getLocation());
    }

    @EventHandler(ignoreCancelled = true)
    public void onDeath(EntityDeathEvent event) {
        if (!halloween()) return;
        LivingEntity mob = event.getEntity();
        if (mob instanceof Player || mob.getKiller() == null) return;
        if (bloodActive && mob instanceof Monster) {
            event.setDroppedExp(event.getDroppedExp() * 2);
            // Double loot, never of anything one of a kind: a mob that picked up a
            // player's sword is persistent, and a single sword is not doubled either way.
            if (mob.getRemoveWhenFarAway()) {
                List<ItemStack> more = new ArrayList<>();
                for (ItemStack drop : event.getDrops()) {
                    if (drop != null && drop.getMaxStackSize() > 1) more.add(drop.clone());
                }
                event.getDrops().addAll(more);
            }
        }
        if (settings.treats() && mob.getScoreboardTags().contains(SeasonalMobs.HEAD_TAG) && random.nextInt(100) < TREAT_CHANCE) {
            event.getDrops().add(random.nextBoolean() ? new ItemStack(Material.COOKIE, 2) : new ItemStack(Material.PUMPKIN_PIE));
        }
    }

    /** A seasonal phantom keeps half its bite. */
    @EventHandler(ignoreCancelled = true)
    public void onDamage(EntityDamageByEntityEvent event) {
        if (event.getDamager() instanceof Phantom phantom && phantom.getScoreboardTags().contains(TAG))
            event.setDamage(event.getDamage() * PHANTOM_DAMAGE);
    }

    /** Nothing this added comes back from disk: it was for one moment of one night. */
    @EventHandler
    public void onLoad(EntitiesLoadEvent event) {
        for (Entity entity : event.getEntities()) if (entity.getScoreboardTags().contains(TAG)) entity.remove();
    }

    // ------------------------------------------------------------------ bats

    private void swarm(World world, Player player) {
        long dusk = world.getFullTime() / 24_000L;
        Long last = swarmedDusk.get(player.getUniqueId());
        if (last != null && last == dusk) return;
        swarmedDusk.put(player.getUniqueId(), dusk);
        int alive = world.getNearbyEntities(player.getLocation(), 128, 128, 128,
                entity -> entity instanceof Bat && entity.getScoreboardTags().contains(TAG)).size();
        int count = Math.min(MAX_SWARM, Math.max(1, BATS_PER_SWARM * settings.batPercent() / 100));
        count = Math.min(count, MAX_BATS - alive);
        double angle = random.nextDouble() * Math.PI * 2;
        Location at = player.getLocation();
        double x = at.getX() + Math.cos(angle) * (6 + random.nextInt(5));
        double z = at.getZ() + Math.sin(angle) * (6 + random.nextInt(5));
        double y = at.getY() + 3 + random.nextInt(3);
        for (int i = 0; i < count; i++) {
            bat(world, x + random.nextGaussian(), y + random.nextGaussian() * 0.5, z + random.nextGaussian(), 1);
        }
    }

    private void bat(World world, double x, double y, double z, int age) {
        Location at = new Location(world, x, y, z, random.nextFloat() * 360f, 0f);
        if (!world.isChunkLoaded(at.getBlockX() >> 4, at.getBlockZ() >> 4) || !at.getBlock().isPassable()) return;
        world.spawn(at, Bat.class, bat -> {
            bat.setAwake(true);
            bat.addScoreboardTag(TAG);
            bat.setTicksLived(Math.max(1, age));
        });
    }

    // ------------------------------------------------------------------ trap pumpkins

    /**
     * A decorative pumpkin a player knocked down ({@link SeasonalDecor#takeDown}),
     * which may have been a trap. The hit on it was already called off, so the
     * grass under it stays.
     */
    private void trap(Player player, Block block) {
        if (!halloween() || settings.trapPercent() == 0) return;
        World world = block.getWorld();
        Random trap = new Random(world.getSeed() ^ pack(block.getX(), block.getY(), block.getZ()) * 0x9E3779B97F4A7C15L ^ 0x7A3C0FFEEL);
        if (trap.nextInt(100 * 100) >= TRAP_BASE * settings.trapPercent()) return;
        Integer last = trapAt.get(player.getUniqueId());
        if (last != null && ticks - last < TRAP_COOLDOWN) return;
        trapAt.put(player.getUniqueId(), ticks);
        Location at = block.getLocation().add(0.5, 1, 0.5);
        world.spawnParticle(Particle.LARGE_SMOKE, at, 16, 0.4, 0.4, 0.4, 0.02);
        if (trap.nextBoolean()) {
            int bats = 2 + trap.nextInt(2);
            for (int i = 0; i < bats; i++) bat(world, at.getX(), at.getY() + 0.5, at.getZ(), BAT_LIFE - TRAP_BAT_LIFE);
        } else if (at.getBlock().isPassable() && at.clone().add(0, 1, 0).getBlock().isPassable()) {
            world.spawn(at, Zombie.class, zombie -> zombie.setBaby());
        }
    }

    // ------------------------------------------------------------------ the blood night

    private void bloodNight(World world, boolean night) {
        if (bloodActive) {
            if (!night) endBloodNight();
            return;
        }
        int key = settings.bloodKey();
        if (key == 0 || key == bloodDone || !night) return;
        // Only a night that has most of itself left, with somebody here to see it -
        // in any world, since the blood night reaches all of them.
        if (world.getTime() > 18_000 || Bukkit.getOnlinePlayers().isEmpty()) return;
        bloodActive = true;
        bloodDone = key;
        save();
        broadcast(HalloweenSettings.Line.BLOOD_START, ChatColor.DARK_RED);
    }

    private void endBloodNight() {
        bloodActive = false;
        broadcast(HalloweenSettings.Line.BLOOD_END, ChatColor.GRAY);
    }

    /** Every player online gets the line in their own language. */
    private void broadcast(HalloweenSettings.Line line, ChatColor color) {
        for (Player player : Bukkit.getOnlinePlayers()) player.sendMessage(color + words(player, line));
    }

    /** A line for one player, in their client's language. */
    private String words(Player player, HalloweenSettings.Line line) {
        return settings.words(line, player.getLocale());
    }

    private void fog() {
        Particle.DustOptions red = new Particle.DustOptions(Color.fromRGB(0x8A, 0x03, 0x03), 3.0f);
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (player.getGameMode() == GameMode.SPECTATOR) continue;
            Location at = player.getLocation();
            player.spawnParticle(Particle.DUST, at.getX(), at.getY() + 1, at.getZ(), 10, 9, 2, 9, 0, red);
        }
    }

    // ------------------------------------------------------------------ the night's visitors

    private void phantom(World world, Player player) {
        if (random.nextInt(PHANTOM_ODDS) != 0) return;
        if (phantomsAlive >= MAX_PHANTOMS) return;
        if (nearbyTagged(world, player.getLocation(), 64, Phantom.class) >= PHANTOMS_NEAR) return;
        Location at = player.getLocation().add(random.nextInt(21) - 10, 20 + random.nextInt(9), random.nextInt(21) - 10);
        if (at.getY() >= world.getMaxHeight() || !at.getBlock().isPassable()) return;
        world.spawn(at, Phantom.class, phantom -> {
            phantom.setSize(0);
            phantom.addScoreboardTag(TAG);
        });
        phantomsAlive++;
    }

    private void trickOrTreater(World world, Player player) {
        if (random.nextInt(TRICK_ODDS) != 0) return;
        if (tricksAlive >= MAX_TRICKS) return;
        if (nearbyTagged(world, player.getLocation(), TRICK_NEAR, Villager.class) > 0) return;
        Block feet = openGround(world, player.getLocation(), 8, 16);
        if (feet == null) return;
        Location at = feet.getLocation().add(0.5, 0, 0.5);
        at.setYaw(random.nextFloat() * 360f);
        boolean lit = random.nextBoolean();
        world.spawn(at, Villager.class, villager -> {
            // A nitwit takes no job: it is only visiting.
            Villager.Profession nitwit = Registry.VILLAGER_PROFESSION.get(NamespacedKey.minecraft("nitwit"));
            if (nitwit != null) villager.setProfession(nitwit);
            EntityEquipment equipment = villager.getEquipment();
            if (equipment != null) {
                equipment.setHelmet(new ItemStack(lit ? Material.JACK_O_LANTERN : Material.CARVED_PUMPKIN));
                equipment.setHelmetDropChance(0f);
            }
            // A name over a head is seen by everybody at once, so it stays in the server's language.
            villager.setCustomName(ChatColor.GOLD + settings.words(HalloweenSettings.Line.TRICK_NAME));
            villager.setCustomNameVisible(true);
            villager.addScoreboardTag(TAG);
            villager.addScoreboardTag(TRICK_TAG);
        });
        tricksAlive++;
    }

    @EventHandler(ignoreCancelled = true)
    public void onInteract(PlayerInteractEntityEvent event) {
        if (!(event.getRightClicked() instanceof Villager villager) || !villager.getScoreboardTags().contains(TRICK_TAG)) return;
        event.setCancelled(true);
        if (event.getHand() != EquipmentSlot.HAND) return;
        Player player = event.getPlayer();
        ItemStack held = player.getInventory().getItemInMainHand();
        Material type = held.getType();
        if (type != Material.PUMPKIN && type != Material.CARVED_PUMPKIN && type != Material.JACK_O_LANTERN) {
            actionBar(player, words(player, HalloweenSettings.Line.TRICK_ASK));
            return;
        }
        int given = treatsGiven.getOrDefault(villager.getUniqueId(), 0);
        if (given >= TRICK_TREATS) return;
        treatsGiven.put(villager.getUniqueId(), given + 1);
        if (player.getGameMode() != GameMode.CREATIVE) held.setAmount(held.getAmount() - 1);
        World world = villager.getWorld();
        if (random.nextInt(100) < TRICK_SCARE_CHANCE) {
            player.addPotionEffect(new PotionEffect(PotionEffectType.BLINDNESS, 60, 0));
            world.playSound(villager.getLocation(), "minecraft:entity.witch.celebrate", 1f, 1f);
            actionBar(player, ChatColor.DARK_PURPLE + words(player, HalloweenSettings.Line.TRICK_SCARE));
            return;
        }
        int roll = random.nextInt(100);
        ItemStack treat = roll < 45 ? new ItemStack(Material.COOKIE, 3)
                : roll < 80 ? new ItemStack(Material.PUMPKIN_PIE)
                : roll < 92 ? new ItemStack(Material.GOLDEN_CARROT)
                : new ItemStack(Material.EMERALD);
        for (ItemStack left : player.getInventory().addItem(treat).values()) world.dropItemNaturally(player.getLocation(), left);
        world.playSound(villager.getLocation(), "minecraft:entity.villager.yes", 1f, 1f);
        world.spawnParticle(Particle.HAPPY_VILLAGER, villager.getLocation().add(0, 1.8, 0), 6, 0.3, 0.3, 0.3, 0);
        actionBar(player, ChatColor.GOLD + words(player, HalloweenSettings.Line.TRICK_TREAT));
    }

    private static void actionBar(Player player, String line) {
        player.spigot().sendMessage(ChatMessageType.ACTION_BAR, new TextComponent(line));
    }

    private void horseman(World world, List<Player> outside) {
        long night = world.getFullTime() / 24_000L;
        if (horsemanNight == night || random.nextInt(HORSEMAN_ODDS) != 0) return;
        if (horsemanAlive) return;
        Player player = outside.get(random.nextInt(outside.size()));
        Block feet = openGround(world, player.getLocation(), 24, 40);
        if (feet == null) return;
        Location at = feet.getLocation().add(0.5, 0, 0.5);
        at.setYaw(random.nextFloat() * 360f);
        SkeletonHorse horse = world.spawn(at, SkeletonHorse.class, spawned -> {
            spawned.setTamed(true);
            spawned.setAdult();
            spawned.addScoreboardTag(TAG);
            spawned.addScoreboardTag(HORSEMAN_TAG);
        });
        Skeleton rider = world.spawn(at, Skeleton.class, spawned -> {
            EntityEquipment equipment = spawned.getEquipment();
            if (equipment != null) {
                equipment.setHelmet(new ItemStack(Material.JACK_O_LANTERN));
                equipment.setHelmetDropChance(0f);
                equipment.setItemInMainHand(new ItemStack(Material.BOW));
            }
            // A name over a head is seen by everybody at once, so it stays in the server's language.
            spawned.setCustomName(ChatColor.GOLD + settings.words(HalloweenSettings.Line.HORSEMAN));
            spawned.setCustomNameVisible(true);
            spawned.addScoreboardTag(TAG);
            spawned.addScoreboardTag(HORSEMAN_TAG);
        });
        horse.addPassenger(rider);
        horsemanNight = night;
        horsemanAlive = true;
    }

    /** Somewhere open on natural ground a little way off, or null. */
    private Block openGround(World world, Location around, int min, int max) {
        for (int tries = 0; tries < 6; tries++) {
            double angle = random.nextDouble() * Math.PI * 2;
            int distance = min + random.nextInt(max - min + 1);
            int x = around.getBlockX() + (int) Math.round(Math.cos(angle) * distance);
            int z = around.getBlockZ() + (int) Math.round(Math.sin(angle) * distance);
            if (!world.isChunkLoaded(x >> 4, z >> 4)) continue;
            Block ground = world.getHighestBlockAt(x, z, HeightMap.MOTION_BLOCKING_NO_LEAVES);
            Material under = ground.getType();
            if (!SeasonalDecor.natural(ground) || under.isAir() || Tag.LEAVES.isTagged(under) || !under.isSolid()) continue;
            Block feet = ground.getRelative(BlockFace.UP);
            if (!feet.getType().isAir() || !feet.getRelative(BlockFace.UP).getType().isAir()) continue;
            return feet;
        }
        return null;
    }

    // ------------------------------------------------------------------ graves

    private void graveyard(World world, List<Player> outside) {
        int cap = GRAVEYARDS * settings.gravePercent() / 100;
        if (graveyards.size() >= cap || ticks - lastGraveTick < GRAVE_EVERY) return;
        lastGraveTick = ticks;
        Player player = outside.get(random.nextInt(outside.size()));
        for (int tries = 0; tries < 4; tries++) {
            double angle = random.nextDouble() * Math.PI * 2;
            int distance = GRAVE_MIN_DISTANCE + random.nextInt(GRAVE_MAX_DISTANCE - GRAVE_MIN_DISTANCE + 1);
            int x = player.getLocation().getBlockX() + (int) Math.round(Math.cos(angle) * distance);
            int z = player.getLocation().getBlockZ() + (int) Math.round(Math.sin(angle) * distance);
            Graveyard made = makeGraveyard(world, x, z);
            if (made == null) continue;
            graveyards.add(made);
            save();
            return;
        }
    }

    /** Three stones in a row and a chest before them, on wild grass with nothing built near, or null. */
    private Graveyard makeGraveyard(World world, int x, int z) {
        for (Graveyard other : graveyards) {
            if (Math.abs(unpackX(other.chest()) - x) < GRAVE_SPACING && Math.abs(unpackZ(other.chest()) - z) < GRAVE_SPACING) return null;
        }
        int span = GRAVE_CLEAR_RADIUS + 2;
        for (int cx = (x - span) >> 4; cx <= (x + span) >> 4; cx++) {
            for (int cz = (z - span) >> 4; cz <= (z + span) >> 4; cz++) if (!world.isChunkLoaded(cx, cz)) return null;
        }
        Block center = world.getHighestBlockAt(x, z, HeightMap.MOTION_BLOCKING_NO_LEAVES);
        if (center.getY() <= world.getMinHeight()) return null;
        boolean eastward = random.nextBoolean();
        BlockFace along = eastward ? BlockFace.EAST : BlockFace.SOUTH;
        BlockFace front = eastward ? BlockFace.SOUTH : BlockFace.EAST;
        List<Block> grounds = List.of(center.getRelative(along, -2), center, center.getRelative(along, 2), center.getRelative(front, 2));
        for (Block ground : grounds) {
            if (world.getHighestBlockAt(ground.getX(), ground.getZ(), HeightMap.MOTION_BLOCKING_NO_LEAVES).getY() != center.getY()) return null;
            if (!SeasonalDecor.naturalGrass(ground)) return null;
        }
        if (!wild(center)) return null;
        List<Long> stones = new ArrayList<>(3);
        for (int i = 0; i < 3; i++) {
            Block stone = grounds.get(i).getRelative(BlockFace.UP);
            stone.setType(STONES[random.nextInt(STONES.length)]);
            stones.add(pack(stone.getX(), stone.getY(), stone.getZ()));
        }
        Block chestBlock = grounds.get(3).getRelative(BlockFace.UP);
        chestBlock.setType(Material.CHEST);
        BlockData data = chestBlock.getBlockData();
        if (data instanceof Directional directional) {
            directional.setFacing(front);
            chestBlock.setBlockData(directional);
        }
        Map<String, Integer> loot = new HashMap<>();
        if (chestBlock.getState() instanceof Chest chest) {
            Inventory inventory = chest.getBlockInventory();
            Material[] items = {Material.BONE, Material.ROTTEN_FLESH, Material.IRON_NUGGET, Material.GOLD_NUGGET,
                    Material.STRING, Material.COOKIE, Material.PUMPKIN_PIE, Material.CANDLE};
            int stacks = 3 + random.nextInt(3);
            for (int i = 0; i < stacks; i++) {
                Material item = items[random.nextInt(items.length)];
                int amount = item == Material.PUMPKIN_PIE || item == Material.CANDLE ? 1 : 1 + random.nextInt(4);
                inventory.setItem(random.nextInt(inventory.getSize()), new ItemStack(item, amount));
            }
            for (ItemStack stack : inventory.getContents()) {
                if (stack != null && !stack.getType().isAir()) loot.merge(stack.getType().getKey().toString(), stack.getAmount(), Integer::sum);
            }
        }
        return new Graveyard(stones, pack(chestBlock.getX(), chestBlock.getY(), chestBlock.getZ()), loot);
    }

    /** Nothing anybody built within reach of a graveyard: every block round it is one the world grew. */
    private static boolean wild(Block center) {
        for (int dx = -GRAVE_CLEAR_RADIUS; dx <= GRAVE_CLEAR_RADIUS; dx += 2) {
            for (int dz = -GRAVE_CLEAR_RADIUS; dz <= GRAVE_CLEAR_RADIUS; dz += 2) {
                for (int dy = -1; dy <= GRAVE_CLEAR_HEIGHT; dy++) {
                    if (!SeasonalDecor.natural(center.getRelative(dx, dy, dz))) return false;
                }
            }
        }
        return true;
    }

    /**
     * Graveyards down, where their chunks are loaded; the rest wait for a later
     * pass. A stone only if it is still one of ours, a chest only if it holds
     * nothing but what was left in it - one somebody filled stays theirs.
     */
    private void takeGraveyardsDown() {
        World world = overworld();
        if (world == null || graveyards.isEmpty()) return;
        boolean changed = false;
        for (int i = graveyards.size() - 1; i >= 0; i--) {
            Graveyard graveyard = graveyards.get(i);
            boolean loadedHere = world.isChunkLoaded(unpackX(graveyard.chest()) >> 4, unpackZ(graveyard.chest()) >> 4);
            for (long stone : graveyard.stones()) loadedHere &= world.isChunkLoaded(unpackX(stone) >> 4, unpackZ(stone) >> 4);
            if (!loadedHere) continue;
            for (long packed : graveyard.stones()) {
                Block stone = world.getBlockAt(unpackX(packed), unpackY(packed), unpackZ(packed));
                Material type = stone.getType();
                if (type == Material.MOSSY_COBBLESTONE_WALL || type == Material.COBBLESTONE_WALL || type == Material.STONE_BRICK_WALL) {
                    stone.setType(Material.AIR);
                }
            }
            Block chestBlock = world.getBlockAt(unpackX(graveyard.chest()), unpackY(graveyard.chest()), unpackZ(graveyard.chest()));
            if (chestBlock.getState() instanceof Chest chest && onlyLoot(chest.getBlockInventory(), graveyard.loot())) {
                chest.getBlockInventory().clear();
                chestBlock.setType(Material.AIR);
            }
            graveyards.remove(i);
            changed = true;
        }
        if (changed) save();
    }

    private static boolean onlyLoot(Inventory inventory, Map<String, Integer> loot) {
        Map<String, Integer> left = new HashMap<>(loot);
        for (ItemStack stack : inventory.getContents()) {
            if (stack == null || stack.getType().isAir()) continue;
            String id = stack.getType().getKey().toString();
            int allowed = left.getOrDefault(id, 0);
            if (stack.getAmount() > allowed) return false;
            left.put(id, allowed - stack.getAmount());
        }
        return true;
    }

    // ------------------------------------------------------------------ what is kept

    /** A block position packed as the game packs it, so the mod and the plugin write the same file. */
    private static long pack(int x, int y, int z) {
        return ((long) x & 0x3FFFFFFL) << 38 | ((long) z & 0x3FFFFFFL) << 12 | ((long) y & 0xFFFL);
    }

    private static int unpackX(long packed) {
        return (int) (packed >> 38);
    }

    private static int unpackY(long packed) {
        return (int) (packed << 52 >> 52);
    }

    private static int unpackZ(long packed) {
        return (int) (packed << 26 >> 38);
    }

    private void load() {
        loaded = true;
        World world = overworld();
        if (world == null) return;
        stateFile = world.getWorldFolder().toPath().resolve(STATE_FILE);
        if (!Files.isRegularFile(stateFile)) return;
        try {
            JsonObject root = JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8)).getAsJsonObject();
            bloodDone = root.has("bloodDone") ? root.get("bloodDone").getAsInt() : 0;
            seasonEndsMillis = root.has("seasonEnds") ? root.get("seasonEnds").getAsLong() : 0;
            if (root.has("graveyards")) {
                for (JsonElement element : root.getAsJsonArray("graveyards")) {
                    JsonObject one = element.getAsJsonObject();
                    List<Long> stones = new ArrayList<>();
                    for (JsonElement stone : one.getAsJsonArray("stones")) stones.add(stone.getAsLong());
                    Map<String, Integer> loot = new HashMap<>();
                    for (Map.Entry<String, JsonElement> entry : one.getAsJsonObject("loot").entrySet()) {
                        if (NamespacedKey.fromString(entry.getKey()) != null) loot.put(entry.getKey(), entry.getValue().getAsInt());
                    }
                    graveyards.add(new Graveyard(stones, one.get("chest").getAsLong(), loot));
                }
            }
        } catch (IOException | RuntimeException unreadable) {
            plugin.getLogger().warning("Polaris could not read " + stateFile + "; its graveyards stay where they are: " + unreadable);
        }
    }

    /** Written beside the world, to a temporary name and moved over, so a crash never leaves half a file. */
    private void save() {
        if (stateFile == null) return;
        JsonObject root = new JsonObject();
        root.addProperty("bloodDone", bloodDone);
        root.addProperty("seasonEnds", seasonEndsMillis);
        JsonArray list = new JsonArray();
        for (Graveyard graveyard : graveyards) {
            JsonObject one = new JsonObject();
            JsonArray stones = new JsonArray();
            for (long stone : graveyard.stones()) stones.add(stone);
            one.add("stones", stones);
            one.addProperty("chest", graveyard.chest());
            JsonObject loot = new JsonObject();
            for (Map.Entry<String, Integer> entry : graveyard.loot().entrySet()) loot.addProperty(entry.getKey(), entry.getValue());
            one.add("loot", loot);
            list.add(one);
        }
        root.add("graveyards", list);
        try {
            Path temporary = stateFile.resolveSibling(STATE_FILE + ".tmp");
            Files.writeString(temporary, root.toString(), StandardCharsets.UTF_8);
            Files.move(temporary, stateFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException failed) {
            plugin.getLogger().warning("Polaris could not write " + stateFile + ": " + failed);
        }
    }

    // ------------------------------------------------------------------ helpers

    private static int nearby(World world, Location at, double radius, Class<? extends Entity> type) {
        return world.getNearbyEntities(at, radius, radius, radius, type::isInstance).size();
    }

    private static int nearbyTagged(World world, Location at, double radius, Class<? extends Entity> type) {
        return world.getNearbyEntities(at, radius, radius, radius,
                entity -> type.isInstance(entity) && entity.getScoreboardTags().contains(TAG)).size();
    }

    /** The loaded entities this added, gathered first so they can be changed. */
    private static List<Entity> tagged(World world) {
        List<Entity> found = new ArrayList<>();
        for (Entity entity : world.getEntities()) if (entity.getScoreboardTags().contains(TAG)) found.add(entity);
        return found;
    }
}
