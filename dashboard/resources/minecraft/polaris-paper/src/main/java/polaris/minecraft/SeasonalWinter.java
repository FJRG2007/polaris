package polaris.minecraft;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.Set;
import java.util.function.Predicate;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.GameMode;
import org.bukkit.HeightMap;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Biome;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Horse;
import org.bukkit.entity.Player;
import org.bukkit.entity.Snowball;
import org.bukkit.entity.Snowman;
import org.bukkit.entity.Villager;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.EntityBlockFormEvent;
import org.bukkit.event.entity.ProjectileHitEvent;
import org.bukkit.event.world.EntitiesLoadEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.MerchantRecipe;
import org.bukkit.plugin.Plugin;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.util.Vector;

/**
 * Christmas and New Year's Eve, on top of the winter {@link SeasonalDecor} and
 * {@link SeasonalMobs} already bring, as the dashboard last said with
 * {@code polaris season winter key=value ...} ({@link WinterPlan}). The same as
 * the NeoForge mod's.
 *
 * Here: snow golems wearing carved pumpkins in snowy villages and plains, herds
 * of reindeer in the taiga, a grumpy snowman now and then at night throwing
 * snowballs that slow, and Santa visiting one player's home each night. The
 * presents and the elves are {@link SeasonalWinterGifts}', the midnights
 * {@link SeasonalNewYear}'s, the lights and the snow {@link SeasonalWinterDecor}'s.
 *
 * Everything this brings stays near players, a few at most per player, and
 * carries a tag: it leaves when nobody is near, when its setting goes to none,
 * and when the winter ends - and a chunk loaded after that brings none of it
 * back. A reindeer somebody tamed is theirs to keep.
 */
final class SeasonalWinter implements Listener {
    static final String GOLEM_TAG = "polaris_winter_golem";
    static final String REINDEER_TAG = "polaris_winter_reindeer";
    static final String SNOWMAN_TAG = "polaris_winter_snowman";
    static final String SANTA_TAG = "polaris_winter_santa";
    static final String SNOWBALL_TAG = "polaris_winter_snowball";

    private static final int SWEEP_TICKS = 100;
    private static final int SNOWMAN_TICKS = 10;
    private static final double NEAR = 48;
    private static final double LEAVE = 96;
    private static final int GOLEMS_NEAR = 2;
    private static final int REINDEER_NEAR = 4;
    private static final int SNOWMEN_NEAR = 1;
    private static final int GOLEM_ODDS = 4;
    private static final int REINDEER_ODDS = 12;
    private static final int SNOWMAN_ODDS = 10;
    private static final double THROW_RANGE = 14;
    private static final int THROW_TICKS = 30;
    private static final int SLOW_TICKS = 60;
    private static final double HOME_NEAR = 64;
    private static final int SANTA_USES = 4;
    /** Where a snow golem melts, and where snow falls, by the block's temperature. */
    private static final double MELTS = 1.0;
    private static final double SNOW_TEMPERATURE = 0.15;

    private static final Set<Biome> TAIGA = Set.of(Biome.TAIGA, Biome.SNOWY_TAIGA,
            Biome.OLD_GROWTH_PINE_TAIGA, Biome.OLD_GROWTH_SPRUCE_TAIGA);

    private static WinterPlan plan = WinterPlan.NONE;

    private final Plugin plugin;
    private final SeasonalDecor decor;
    private final SeasonalWinterStore store;
    private final SeasonalWinterGifts gifts;
    private final SeasonalNewYear newYear;
    private final Random random = new Random();
    private BukkitTask timer;
    private int ticks;

    SeasonalWinter(Plugin plugin, SeasonalDecor decor) {
        this.plugin = plugin;
        this.decor = decor;
        this.store = new SeasonalWinterStore(plugin);
        this.gifts = new SeasonalWinterGifts(this, store);
        this.newYear = new SeasonalNewYear(store);
    }

    /** What the dashboard last said; nothing on outside a winter. */
    static WinterPlan plan() {
        return plan;
    }

    /** The elves and presents, which listen alongside this. */
    SeasonalWinterGifts gifts() {
        return gifts;
    }

    void start() {
        if (timer == null) timer = Bukkit.getScheduler().runTaskTimer(plugin, this::tick, 1, 1);
    }

    void stop() {
        if (timer != null) timer.cancel();
        timer = null;
        plan = WinterPlan.NONE;
        newYear.forget();
        gifts.forget();
    }

    // ------------------------------------------------------------------ commands

    /** {@code polaris season winter <key=value ...>}. */
    JsonObject answer(String[] args) {
        if (decor.season() != SeasonalDecor.Season.WINTER) return SoundPack.refused("notWinter");
        WinterPlan next;
        try {
            next = WinterPlan.parse(args);
        } catch (IllegalArgumentException bad) {
            return SoundPack.refused("usage");
        }
        WinterPlan before = plan;
        plan = next;
        presentsGo(!next.presentsNow());
        if (before.snow() != next.snow() || before.lights() != next.lights()) decor.redraw();
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("christmas", plan.christmas());
        reply.addProperty("day", plan.day());
        reply.addProperty("eveAt", plan.eveAt());
        reply.addProperty("newYearAt", plan.newYearAt());
        return reply;
    }

    // ------------------------------------------------------------------ events

    private void tick() {
        try {
            if (decor.season() != SeasonalDecor.Season.WINTER && plan != WinterPlan.NONE) end();
            ticks++;
            if (plan != WinterPlan.NONE) newYear.tick();
            if (ticks % SNOWMAN_TICKS == 0) {
                if (plan != WinterPlan.NONE && ticks % THROW_TICKS == 0) snowmenThrow();
                gifts.elves();
            }
            if (ticks % SWEEP_TICKS == 0) {
                sweep();
                gifts.sweep();
            }
        } catch (RuntimeException failed) {
            // A tick must never fail over Christmas: stop bringing anything until told again.
            plugin.getLogger().severe("Polaris Christmas and New Year failed and are off until told again: " + failed);
            plan = WinterPlan.NONE;
        }
    }

    /** A seasonal golem or snowman leaves no snow trail. */
    @EventHandler(ignoreCancelled = true)
    public void onForm(EntityBlockFormEvent event) {
        Set<String> tags = event.getEntity().getScoreboardTags();
        if (tags.contains(GOLEM_TAG) || tags.contains(SNOWMAN_TAG)) event.setCancelled(true);
    }

    /** A chunk loaded after the winter, or by day, brings none of it back. */
    @EventHandler
    public void onLoad(EntitiesLoadEvent event) {
        boolean winter = decor.season() == SeasonalDecor.Season.WINTER;
        for (Entity entity : event.getEntities()) {
            Set<String> tags = entity.getScoreboardTags();
            if (tags.contains(GOLEM_TAG)) {
                if (!winter || plan.golems() == 0) entity.remove();
            } else if (tags.contains(REINDEER_TAG)) {
                if (entity instanceof Horse horse && horse.isTamed()) horse.removeScoreboardTag(REINDEER_TAG);
                else if (!winter || plan.reindeer() == 0) entity.remove();
            } else if (tags.contains(SNOWMAN_TAG) || tags.contains(SANTA_TAG)) {
                if (!winter || !night(entity.getWorld())) entity.remove();
            } else if (tags.contains(SNOWBALL_TAG) || tags.contains(SeasonalWinterGifts.ELF_TAG)) {
                // An elf's item, if it had one, is given back from the store.
                entity.remove();
            }
        }
    }

    /** A grumpy snowman's snowball slows whoever it hits. */
    @EventHandler
    public void onHit(ProjectileHitEvent event) {
        if (!event.getEntity().getScoreboardTags().contains(SNOWBALL_TAG)) return;
        if (event.getHitEntity() instanceof Player player) {
            player.addPotionEffect(new PotionEffect(PotionEffectType.SLOWNESS, SLOW_TICKS, 1));
        }
    }

    // ------------------------------------------------------------------ the sweep

    /** The winter over: everything it brought leaves, and what an elf holds goes back. */
    private void end() {
        plan = WinterPlan.NONE;
        newYear.forget();
        presentsGo(true);
        sendAway(entity -> true);
    }

    /** Whether the presents are to come down, kept across a restart: a jar not told yet keeps them. */
    private void presentsGo(boolean go) {
        if (store.data().getBoolean(SeasonalWinterStore.PRESENTS_GO) == go) return;
        store.data().set(SeasonalWinterStore.PRESENTS_GO, go);
        store.save();
    }

    /** Night as the overworld's clock tells it, as the other seasonal touches read it. */
    static boolean night(World world) {
        long time = world.getTime();
        return time >= 13_000 && time <= 23_000;
    }

    private void sweep() {
        World overworld = Bukkit.getWorlds().isEmpty() ? null : Bukkit.getWorlds().get(0);
        boolean night = overworld != null && night(overworld);
        sendAway(entity -> {
            Set<String> tags = entity.getScoreboardTags();
            if (tags.contains(GOLEM_TAG)) return plan.golems() == 0 || alone(entity, LEAVE);
            if (tags.contains(REINDEER_TAG)) {
                if (entity instanceof Horse horse && horse.isTamed()) {
                    horse.removeScoreboardTag(REINDEER_TAG);
                    return false;
                }
                return plan.reindeer() == 0 || alone(entity, LEAVE);
            }
            if (tags.contains(SNOWMAN_TAG)) return plan.snowmen() == 0 || !night || alone(entity, LEAVE);
            if (tags.contains(SANTA_TAG)) return !plan.santaNow() || !night || alone(entity, 2 * LEAVE);
            return false;
        });
        if (plan == WinterPlan.NONE) return;
        for (Player player : Bukkit.getOnlinePlayers()) {
            World world = player.getWorld();
            if (world.getEnvironment() != World.Environment.NORMAL || player.getGameMode() == GameMode.SPECTATOR) continue;
            Block at = player.getLocation().getBlock();
            if (plan.golems() > 0 && snowyVillageOrPlain(at) && random.nextInt(GOLEM_ODDS) == 0
                    && near(player, GOLEM_TAG) < WinterPlan.cap(GOLEMS_NEAR, plan.golems())) {
                Block spot = spot(world, at, 14, 30, block -> block.getTemperature() < SNOW_TEMPERATURE);
                if (spot != null) bringGolem(spot, GOLEM_TAG, true);
            }
            if (plan.reindeer() > 0 && TAIGA.contains(at.getBiome()) && random.nextInt(REINDEER_ODDS) == 0) {
                int room = WinterPlan.cap(REINDEER_NEAR, plan.reindeer()) - near(player, REINDEER_TAG);
                Block spot = room >= 2 ? spot(world, at, 20, 36, block -> TAIGA.contains(block.getBiome())) : null;
                if (spot != null) bringHerd(spot, Math.min(room, 2 + random.nextInt(3)));
            }
            if (plan.snowmen() > 0 && night && random.nextInt(SNOWMAN_ODDS) == 0
                    && near(player, SNOWMAN_TAG) < WinterPlan.cap(SNOWMEN_NEAR, plan.snowmen())) {
                Block spot = spot(world, at, 16, 28, block -> block.getTemperature() <= MELTS);
                if (spot != null) bringGolem(spot, SNOWMAN_TAG, false);
            }
        }
        if (plan.santaNow() && night) santa(overworld);
    }

    private static boolean snowyVillageOrPlain(Block at) {
        if (at.getTemperature() >= SNOW_TEMPERATURE) return false;
        if (at.getBiome() == Biome.SNOWY_PLAINS) return true;
        return !at.getWorld().getNearbyEntities(at.getLocation(), NEAR, 16, NEAR, entity -> entity instanceof Villager).isEmpty();
    }

    private static boolean alone(Entity entity, double distance) {
        return entity.getWorld().getNearbyEntities(entity.getLocation(), distance, distance, distance,
                other -> other instanceof Player).isEmpty();
    }

    static int near(Player player, String tag) {
        return player.getWorld().getNearbyEntities(player.getLocation(), NEAR, NEAR, NEAR,
                entity -> entity.getScoreboardTags().contains(tag)).size();
    }

    /** Every loaded visitor this brought that should leave, gone. */
    private static void sendAway(Predicate<Entity> leaves) {
        for (World world : Bukkit.getWorlds()) {
            List<Entity> going = new ArrayList<>();
            for (Entity entity : world.getEntities()) {
                Set<String> tags = entity.getScoreboardTags();
                boolean ours = tags.contains(GOLEM_TAG) || tags.contains(REINDEER_TAG)
                        || tags.contains(SNOWMAN_TAG) || tags.contains(SANTA_TAG);
                if (ours && leaves.test(entity)) going.add(entity);
            }
            for (Entity entity : going) entity.remove();
        }
    }

    /** Somewhere open, natural and standable a little way off (the feet block), or null. */
    Block spot(World world, Block around, int min, int max, Predicate<Block> where) {
        for (int tries = 0; tries < 6; tries++) {
            double angle = random.nextDouble() * Math.PI * 2;
            int distance = min + random.nextInt(max - min + 1);
            int x = around.getX() + (int) Math.round(Math.cos(angle) * distance);
            int z = around.getZ() + (int) Math.round(Math.sin(angle) * distance);
            if (!world.isChunkLoaded(x >> 4, z >> 4)) continue;
            Block ground = world.getHighestBlockAt(x, z, HeightMap.MOTION_BLOCKING_NO_LEAVES);
            Block feet = ground.getRelative(BlockFace.UP);
            Material under = ground.getType();
            boolean naturalGround = under == Material.SNOW_BLOCK
                    || (SeasonalDecor.natural(ground) && !under.isAir() && !Tag.LEAVES.isTagged(under));
            if (!naturalGround || !under.isSolid()) continue;
            if (!(feet.getType().isAir() || feet.getType() == Material.SNOW)) continue;
            if (!feet.getRelative(BlockFace.UP).getType().isAir() || !where.test(feet)) continue;
            return feet;
        }
        return null;
    }

    // ------------------------------------------------------------------ visitors

    private Location standAt(Block feet) {
        Location at = feet.getLocation().add(0.5, 0, 0.5);
        at.setYaw(random.nextFloat() * 360f);
        return at;
    }

    private void bringGolem(Block feet, String tag, boolean pumpkin) {
        feet.getWorld().spawn(standAt(feet), Snowman.class, golem -> {
            golem.setDerp(!pumpkin);
            golem.addScoreboardTag(tag);
            if (!pumpkin) golem.setCustomName(ChatColor.AQUA + plan.words(WinterPlan.Line.SNOWMAN));
        });
    }

    private void bringHerd(Block feet, int count) {
        for (int i = 0; i < count; i++) {
            Location at = standAt(feet).add(random.nextInt(5) - 2, 0, random.nextInt(5) - 2);
            if (!at.getBlock().getType().isAir() || !at.clone().add(0, 1, 0).getBlock().getType().isAir()) continue;
            feet.getWorld().spawn(at, Horse.class, reindeer -> {
                reindeer.setColor(Horse.Color.BROWN);
                reindeer.setStyle(Horse.Style.NONE);
                reindeer.setCustomName(plan.words(WinterPlan.Line.REINDEER));
                reindeer.addScoreboardTag(REINDEER_TAG);
            });
        }
    }

    /** A grumpy snowman throws at the nearest player it can see. */
    private void snowmenThrow() {
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (player.getGameMode() == GameMode.SPECTATOR || player.getGameMode() == GameMode.CREATIVE) continue;
            for (Entity entity : player.getWorld().getNearbyEntities(player.getLocation(), THROW_RANGE, THROW_RANGE, THROW_RANGE,
                    entity -> entity instanceof Snowman && entity.getScoreboardTags().contains(SNOWMAN_TAG))) {
                Snowman snowman = (Snowman) entity;
                if (!snowman.hasLineOfSight(player) || nearestPlayer(snowman) != player) continue;
                Vector to = player.getEyeLocation().toVector().subtract(snowman.getEyeLocation().toVector());
                to.setY(to.getY() + Math.hypot(to.getX(), to.getZ()) * 0.2);
                Snowball ball = snowman.launchProjectile(Snowball.class, to.normalize().multiply(1.6));
                ball.addScoreboardTag(SNOWBALL_TAG);
            }
        }
    }

    private static Player nearestPlayer(Entity entity) {
        Player nearest = null;
        double best = Double.MAX_VALUE;
        for (Player player : entity.getWorld().getPlayers()) {
            double distance = player.getLocation().distanceSquared(entity.getLocation());
            if (distance < best) {
                best = distance;
                nearest = player;
            }
        }
        return nearest;
    }

    /** Once a night, Santa at one player's home, trading until sunrise. */
    private void santa(World overworld) {
        long night = overworld.getFullTime() / 24_000L;
        if (store.data().getLong(SeasonalWinterStore.SANTA_NIGHT) == night + 1) return;
        List<Player> home = new ArrayList<>();
        for (Player player : Bukkit.getOnlinePlayers()) {
            Location bed = player.getRespawnLocation();
            if (bed == null || bed.getWorld() == null || !bed.getWorld().equals(overworld)) continue;
            if (!player.getWorld().equals(overworld) || player.getGameMode() == GameMode.SPECTATOR) continue;
            if (player.getLocation().distanceSquared(bed) <= HOME_NEAR * HOME_NEAR) home.add(player);
        }
        if (home.isEmpty()) return;
        Player visited = home.get(random.nextInt(home.size()));
        Location bed = visited.getRespawnLocation();
        Block spot = bed == null ? null : standable(bed.getBlock());
        if (spot == null) return;
        overworld.spawn(standAt(spot), Villager.class, santa -> {
            // A master already: never sent back to having no trade, and never levels up.
            santa.setVillagerType(Villager.Type.SNOW);
            santa.setProfession(Villager.Profession.CLERIC);
            santa.setVillagerLevel(5);
            santa.setVillagerExperience(1);
            santa.setRecipes(santaOffers());
            santa.setCustomName(ChatColor.RED + "" + ChatColor.BOLD + plan.words(WinterPlan.Line.SANTA));
            santa.setCustomNameVisible(true);
            santa.setInvulnerable(true);
            santa.addScoreboardTag(SANTA_TAG);
        });
        store.data().set(SeasonalWinterStore.SANTA_NIGHT, night + 1);
        store.save();
        visited.sendMessage(ChatColor.RED + plan.words(WinterPlan.Line.SANTA_VISITS));
    }

    /** Somewhere a villager can stand within a few blocks of a home, or null. */
    private Block standable(Block home) {
        for (int tries = 0; tries < 12; tries++) {
            Block feet = home.getRelative(random.nextInt(9) - 4, random.nextInt(3) - 1, random.nextInt(9) - 4);
            if (!feet.getWorld().isChunkLoaded(feet.getX() >> 4, feet.getZ() >> 4)) continue;
            if (!feet.getRelative(BlockFace.DOWN).getType().isSolid()) continue;
            if (!feet.getType().isAir() || !feet.getRelative(BlockFace.UP).getType().isAir()) continue;
            return feet;
        }
        return null;
    }

    private static List<MerchantRecipe> santaOffers() {
        List<MerchantRecipe> offers = new ArrayList<>();
        offers.add(offer(new ItemStack(Material.COOKIE, 8), 1));
        offers.add(offer(new ItemStack(Material.CAKE), 2));
        offers.add(offer(SeasonalNewYear.rockets(4), 2));
        offers.add(offer(new ItemStack(Material.SNOWBALL, 16), 1));
        offers.add(offer(new ItemStack(Material.SPRUCE_SAPLING, 4), 1));
        offers.add(offer(new ItemStack(Material.RED_WOOL, 8), 1));
        offers.add(offer(new ItemStack(Material.GREEN_WOOL, 8), 1));
        return offers;
    }

    private static MerchantRecipe offer(ItemStack result, int emeralds) {
        MerchantRecipe recipe = new MerchantRecipe(result, SANTA_USES);
        recipe.addIngredient(new ItemStack(Material.EMERALD, emeralds));
        return recipe;
    }
}
