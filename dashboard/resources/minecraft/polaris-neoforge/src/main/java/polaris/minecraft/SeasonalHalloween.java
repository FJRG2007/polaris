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
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.particles.DustParticleOptions;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.RandomSource;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.entity.ambient.Bat;
import net.minecraft.world.entity.animal.horse.SkeletonHorse;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Endermite;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.monster.Phantom;
import net.minecraft.world.entity.monster.Skeleton;
import net.minecraft.world.entity.monster.Witch;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.entity.npc.Villager;
import net.minecraft.world.entity.npc.VillagerProfession;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.AABB;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;
import net.neoforged.neoforge.event.entity.living.FinalizeSpawnEvent;
import net.neoforged.neoforge.event.entity.living.LivingDropsEvent;
import net.neoforged.neoforge.event.entity.living.LivingExperienceDropEvent;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/**
 * Halloween's extra touches, beside {@link SeasonalDecor}'s decorations and
 * {@link SeasonalMobs}' pumpkin heads and night spawns. The dashboard switches
 * each one with {@code polaris season halloween key=value ...}
 * ({@link HalloweenSettings}); all of them wait for the season to be Halloween.
 *
 * - Witches: a natural night spawn may bring a witch, through
 *   {@link SeasonalMobs#queueExtra}, so the same queue, crowd and distance caps hold.
 * - Bats: a swarm round each player under the open sky once a dusk, gone in a minute.
 * - Treats: a pumpkin-headed monster a player kills may drop a cookie or a pie.
 * - The headless horseman: rare, one a night at most, gone at dawn.
 * - Trap pumpkins: a decorative pumpkin a player breaks drops itself, and some
 *   - drawn from where they stand - let out bats, a baby zombie or a swarm of
 *   endermites that bite and are gone in a couple of minutes; the ground under
 *   it, which is all that is really there, stays.
 * - Blood night: once a season, on the night the dashboard names - red fog,
 *   a second spawn for every natural one, double loot and experience. The
 *   night is the overworld's, but it reaches every dimension: somebody in the
 *   Nether is under the same blood night as everybody else.
 * - Trick or treat: a villager in a pumpkin that takes one and gives a treat,
 *   or a short scare; three at most, then it goes.
 * - Phantoms: a few at night over players under the open sky, slept or not,
 *   hitting half as hard.
 * - Graves: small graveyards on wild grass far from anything built, written
 *   down in the world folder with the moment the dashboard says the season
 *   ends, and taken down only once it has passed - not on a restart, nor while
 *   an event pauses the season. A chest somebody filled with their own things
 *   is left standing.
 *
 * Every mob this adds carries {@link #TAG}: it never comes back from disk, and the
 * season ending takes it away. Server thread only.
 */
final class SeasonalHalloween {
    static final String TAG = "polaris_halloween";
    private static final String HORSEMAN_TAG = "polaris_halloween_horseman";
    private static final String TRICK_TAG = "polaris_halloween_trick";

    private static final int SWEEP_TICKS = 100;
    private static final int FOG_TICKS = 10;
    /** One natural night spawn in this many, in percent at 100%, brings a witch. */
    private static final int WITCH_BASE = 6;
    /** Bats in a swarm at 100%, the most in one, the most at once, and their life in ticks. */
    private static final int BATS_PER_SWARM = 5;
    private static final int MAX_SWARM = 12;
    private static final int MAX_BATS = 64;
    private static final int BAT_LIFE = 1200;
    private static final int TRAP_BAT_LIFE = 600;
    /** The fewest endermites an infested pumpkin lets out. */
    private static final int TRAP_MITES = 3;
    /** Of pumpkin-headed kills, the ones that drop a treat, in percent. */
    private static final int TREAT_CHANCE = 8;
    /** One sweep in this many through a night brings the horseman: about one night in three. */
    private static final int HORSEMAN_ODDS = 300;
    /** Decorative pumpkins that are traps at 100%, in percent, and how long between a player's traps. */
    private static final int TRAP_BASE = 15;
    private static final int TRAP_COOLDOWN = 200;
    /** Trick-or-treaters: one sweep in this many per player, at most near one and in all, their treats and life. */
    private static final int TRICK_ODDS = 60;
    private static final double TRICK_NEAR = 64;
    private static final int MAX_TRICKS = 4;
    private static final int TRICK_TREATS = 3;
    private static final int TRICK_LIFE = 6000;
    private static final int TRICK_SCARE_CHANCE = 30;
    /** Phantoms: one sweep in this many per player, at most near one and in all, and the share of damage they keep. */
    private static final int PHANTOM_ODDS = 8;
    private static final int PHANTOMS_NEAR = 2;
    private static final int MAX_PHANTOMS = 16;
    private static final float PHANTOM_DAMAGE = 0.5f;
    /** Graveyards at 100%, the room between them, how far from a player one is made, and how often. */
    private static final int GRAVEYARDS = 4;
    private static final int GRAVE_SPACING = 128;
    private static final int GRAVE_MIN_DISTANCE = 40;
    private static final int GRAVE_MAX_DISTANCE = 72;
    private static final int GRAVE_EVERY = 6000;
    /** How far round a graveyard nothing built may stand, and how high above its ground. */
    private static final int GRAVE_CLEAR_RADIUS = 14;
    private static final int GRAVE_CLEAR_HEIGHT = 4;
    private static final String STATE_FILE = "polaris-halloween.json";

    /** The stones of one graveyard, its chest, and what was put in it. */
    private record Graveyard(List<BlockPos> stones, BlockPos chest, Map<String, Integer> loot) {}

    private static HalloweenSettings settings = HalloweenSettings.OFF;
    private static boolean wasOn;
    private static int ticks;
    private static boolean loaded;
    private static Path stateFile;
    private static final List<Graveyard> graveyards = new ArrayList<>();
    private static int bloodDone;
    /** When the dashboard last said the season ends, in epoch millis; 0 until told. */
    private static long seasonEndsMillis;
    private static boolean bloodActive;
    private static long horsemanNight = -1;
    /** The night's visitors still about, counted once a sweep and as each comes. */
    private static int phantomsAlive;
    private static int tricksAlive;
    private static boolean horsemanAlive;
    private static int lastGraveTick = -GRAVE_EVERY;
    private static final Map<UUID, Long> swarmedDusk = new HashMap<>();
    private static final Map<UUID, Integer> trapAt = new HashMap<>();
    private static final Map<UUID, Integer> treatsGiven = new HashMap<>();

    // ------------------------------------------------------------------ commands

    /** {@code polaris season halloween key=value ...}. */
    static JsonObject configure(MinecraftServer server, String line) {
        HalloweenSettings next = HalloweenSettings.parse(line.trim().split("\\s+"));
        if (next == null) {
            JsonObject reply = new JsonObject();
            reply.addProperty("ok", false);
            reply.addProperty("why", "usage");
            return reply;
        }
        if (!loaded) load(server);
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
            takeGraveyardsDown(server);
        }
        return status();
    }

    static JsonObject status() {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("halloween", SeasonalDecor.season() == SeasonalDecor.Season.HALLOWEEN);
        reply.addProperty("bloodNight", bloodActive);
        reply.addProperty("bloodDone", bloodDone);
        reply.addProperty("graveyards", graveyards.size());
        return reply;
    }

    // ------------------------------------------------------------------ the tick

    @SubscribeEvent
    public void onTick(ServerTickEvent.Post event) {
        MinecraftServer server = event.getServer();
        try {
            ticks++;
            if (!loaded) load(server);
            boolean on = SeasonalDecor.season() == SeasonalDecor.Season.HALLOWEEN;
            if (on != wasOn) {
                if (!on) endSeason(server);
                wasOn = on;
            }
            if (!on) {
                if (!graveyards.isEmpty() && ticks % SWEEP_TICKS == 0 && seasonOver()) takeGraveyardsDown(server);
                return;
            }
            if (bloodActive && ticks % FOG_TICKS == 0) fog(server);
            if (ticks % SWEEP_TICKS == 0) sweep(server);
        } catch (RuntimeException failed) {
            // A tick must never fail over Halloween: everything is off until told again.
            PolarisMod.LOG.error("Polaris Halloween extras failed and are off until told again", failed);
            settings = HalloweenSettings.OFF;
            bloodActive = false;
        }
    }

    private static void endSeason(MinecraftServer server) {
        for (ServerLevel level : server.getAllLevels()) {
            for (Entity entity : tagged(level)) entity.discard();
        }
        if (bloodActive) endBloodNight(server);
        swarmedDusk.clear();
        trapAt.clear();
        treatsGiven.clear();
    }

    /** The season's end the dashboard gave has passed, or it never gave one. */
    private static boolean seasonOver() {
        return seasonEndsMillis == 0 || System.currentTimeMillis() >= seasonEndsMillis;
    }

    private static void sweep(MinecraftServer server) {
        ServerLevel level = server.overworld();
        long time = level.getDayTime() % 24_000L;
        boolean night = time >= 13_000 && time <= 23_000;
        boolean dusk = time >= 11_800 && time < 13_000;
        tidy(level, night);
        bloodNight(server, level, night);
        List<ServerPlayer> outside = new ArrayList<>();
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (player.serverLevel() != level || player.isSpectator()) continue;
            if (level.canSeeSky(BlockPos.containing(player.getX(), player.getEyeY(), player.getZ()))) outside.add(player);
        }
        if (dusk && settings.batPercent() > 0) for (ServerPlayer player : outside) swarm(level, player);
        if (night && settings.phantoms()) for (ServerPlayer player : outside) phantom(level, player);
        if (night && settings.trickOrTreat()) for (ServerPlayer player : outside) trickOrTreater(level, player);
        if (night && settings.horseman() && !outside.isEmpty()) horseman(level, outside);
        if (settings.gravePercent() > 0 && !outside.isEmpty()) graveyard(server, level, outside);
        else if (settings.gravePercent() == 0 && !graveyards.isEmpty()) takeGraveyardsDown(server);
    }

    /** What has had its time goes: bats after a minute, the night's visitors at dawn. */
    private static void tidy(ServerLevel level, boolean night) {
        List<Entity> mine = tagged(level);
        for (Entity entity : mine) {
            if (entity instanceof Bat bat) {
                if (bat.tickCount > BAT_LIFE) bat.discard();
            } else if (entity instanceof Villager villager) {
                Integer given = treatsGiven.get(villager.getUUID());
                boolean done = given != null && given >= TRICK_TREATS;
                if (!night || done || villager.tickCount > TRICK_LIFE || !settings.trickOrTreat()
                        || level.getNearestPlayer(villager, TRICK_NEAR) == null) {
                    level.sendParticles(ParticleTypes.LARGE_SMOKE, villager.getX(), villager.getY() + 1, villager.getZ(),
                            12, 0.3, 0.5, 0.3, 0.02);
                    treatsGiven.remove(villager.getUUID());
                    villager.discard();
                }
            } else if (entity instanceof SkeletonHorse horse) {
                // Its rider fell: the horse is the player's to keep, an ordinary one from now on.
                if (horse.getPassengers().isEmpty()) {
                    horse.removeTag(TAG);
                    horse.removeTag(HORSEMAN_TAG);
                } else if (!night) {
                    horse.discard();
                }
            } else if (!night || entity instanceof Phantom && !settings.phantoms()) {
                entity.discard();
            }
        }
        phantomsAlive = 0;
        tricksAlive = 0;
        horsemanAlive = false;
        for (Entity entity : mine) {
            if (entity.isRemoved()) continue;
            if (entity instanceof Phantom) phantomsAlive++;
            else if (entity instanceof Villager) tricksAlive++;
            else if (entity.getTags().contains(HORSEMAN_TAG)) horsemanAlive = true;
        }
    }

    // ------------------------------------------------------------------ spawns and drops

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onFinalizeSpawn(FinalizeSpawnEvent event) {
        if (SeasonalDecor.season() != SeasonalDecor.Season.HALLOWEEN || event.isSpawnCancelled()) return;
        if (event.getSpawnType() != EntitySpawnReason.NATURAL || SeasonalMobs.spawningExtra()) return;
        ServerLevel level = event.getLevel().getLevel();
        Mob mob = event.getEntity();
        if (!(mob instanceof Monster) || mob.getType().getCategory() != MobCategory.MONSTER
                || mob instanceof Phantom || mob instanceof Witch) return;
        BlockPos pos = BlockPos.containing(event.getX(), event.getY(), event.getZ());
        // The Nether and the End have no night of their own: the blood night is
        // the overworld's, and it doubles their spawns too. Witches stay at home.
        if (level.dimension() != Level.OVERWORLD) {
            if (bloodActive) SeasonalMobs.queueExtra(level, mob.getType(), pos);
            return;
        }
        if (!level.isNight()) return;
        if (settings.witchPercent() > 0 && level.random.nextInt(100 * 100) < WITCH_BASE * settings.witchPercent()) {
            SeasonalMobs.queueExtra(level, EntityType.WITCH, pos);
        }
        if (bloodActive) SeasonalMobs.queueExtra(level, mob.getType(), pos);
    }

    @SubscribeEvent
    public void onDrops(LivingDropsEvent event) {
        if (SeasonalDecor.season() != SeasonalDecor.Season.HALLOWEEN) return;
        if (!(event.getEntity() instanceof Mob mob) || !(event.getSource().getEntity() instanceof ServerPlayer)) return;
        if (!(mob.level() instanceof ServerLevel level)) return;
        if (bloodActive && mob instanceof Monster && !mob.isPersistenceRequired()) {
            // Double loot, never of anything one of a kind: a mob that picked up a
            // player's sword is persistent, and a single sword is not doubled either way.
            List<ItemEntity> more = new ArrayList<>();
            for (ItemEntity drop : event.getDrops()) {
                ItemStack stack = drop.getItem();
                if (stack.getMaxStackSize() <= 1) continue;
                more.add(new ItemEntity(level, drop.getX(), drop.getY(), drop.getZ(), stack.copy()));
            }
            event.getDrops().addAll(more);
        }
        if (settings.treats() && mob.getTags().contains(SeasonalMobs.HEAD_TAG)
                && level.random.nextInt(100) < TREAT_CHANCE) {
            ItemStack treat = level.random.nextBoolean() ? new ItemStack(Items.COOKIE, 2) : new ItemStack(Items.PUMPKIN_PIE);
            ItemEntity drop = new ItemEntity(level, mob.getX(), mob.getY() + 0.5, mob.getZ(), treat);
            drop.setDefaultPickUpDelay();
            event.getDrops().add(drop);
        }
    }

    @SubscribeEvent
    public void onExperience(LivingExperienceDropEvent event) {
        if (!bloodActive || !(event.getEntity() instanceof Monster) || event.getAttackingPlayer() == null) return;
        event.setDroppedExperience(event.getDroppedExperience() * 2);
    }

    /** A seasonal phantom keeps half its bite. */
    @SubscribeEvent
    public void onDamage(LivingIncomingDamageEvent event) {
        Entity attacker = event.getSource().getEntity();
        if (attacker instanceof Phantom && attacker.getTags().contains(TAG)) event.setAmount(event.getAmount() * PHANTOM_DAMAGE);
    }

    /** Nothing this added comes back from disk: it was for one moment of one night. */
    @SubscribeEvent
    public void onJoin(EntityJoinLevelEvent event) {
        if (event.loadedFromDisk() && !event.getLevel().isClientSide() && event.getEntity().getTags().contains(TAG)) {
            event.setCanceled(true);
        }
    }

    // ------------------------------------------------------------------ bats

    private static void swarm(ServerLevel level, ServerPlayer player) {
        long dusk = level.getDayTime() / 24_000L;
        Long last = swarmedDusk.get(player.getUUID());
        if (last != null && last == dusk) return;
        swarmedDusk.put(player.getUUID(), dusk);
        int alive = level.getEntitiesOfClass(Bat.class, player.getBoundingBox().inflate(128), bat -> bat.getTags().contains(TAG)).size();
        int count = Math.min(MAX_SWARM, Math.max(1, BATS_PER_SWARM * settings.batPercent() / 100));
        count = Math.min(count, MAX_BATS - alive);
        RandomSource random = level.random;
        double angle = random.nextDouble() * Math.PI * 2;
        double x = player.getX() + Math.cos(angle) * (6 + random.nextInt(5));
        double z = player.getZ() + Math.sin(angle) * (6 + random.nextInt(5));
        double y = player.getY() + 3 + random.nextInt(3);
        for (int i = 0; i < count; i++) bat(level, x + random.nextGaussian(), y + random.nextGaussian() * 0.5, z + random.nextGaussian(), 0);
    }

    private static void bat(ServerLevel level, double x, double y, double z, int age) {
        BlockPos at = BlockPos.containing(x, y, z);
        if (!level.hasChunk(at.getX() >> 4, at.getZ() >> 4)) return;
        if (!level.noCollision(EntityType.BAT.getSpawnAABB(x, y, z))) return;
        Bat bat = EntityType.BAT.create(level, EntitySpawnReason.EVENT);
        if (bat == null) return;
        bat.moveTo(x, y, z, level.random.nextFloat() * 360f, 0f);
        bat.setResting(false);
        bat.addTag(TAG);
        bat.tickCount = age;
        level.addFreshEntity(bat);
    }

    // ------------------------------------------------------------------ trap pumpkins

    /**
     * A decorative pumpkin a player knocked down ({@link SeasonalDecor#takeDown}),
     * which may have been a trap. The hit on it was already called off, so the
     * grass under it stays.
     */
    static void trap(ServerPlayer player, ServerLevel level, BlockPos pos) {
        if (SeasonalDecor.season() != SeasonalDecor.Season.HALLOWEEN || settings.trapPercent() == 0) return;
        Random trap = new Random(level.getSeed() ^ pos.asLong() * 0x9E3779B97F4A7C15L ^ 0x7A3C0FFEEL);
        if (trap.nextInt(100 * 100) >= TRAP_BASE * settings.trapPercent()) return;
        Integer last = trapAt.get(player.getUUID());
        if (last != null && ticks - last < TRAP_COOLDOWN) return;
        trapAt.put(player.getUUID(), ticks);
        double x = pos.getX() + 0.5;
        double y = pos.getY() + 1;
        double z = pos.getZ() + 0.5;
        level.sendParticles(ParticleTypes.LARGE_SMOKE, x, y, z, 16, 0.4, 0.4, 0.4, 0.02);
        int kind = trap.nextInt(3);
        if (kind == 0) {
            int bats = 2 + trap.nextInt(2);
            for (int i = 0; i < bats; i++) bat(level, x, y + 0.5, z, BAT_LIFE - TRAP_BAT_LIFE);
        } else if (kind == 1) {
            Zombie zombie = EntityType.ZOMBIE.create(level, EntitySpawnReason.EVENT);
            if (zombie == null || !level.noCollision(EntityType.ZOMBIE.getSpawnAABB(x, y, z))) return;
            zombie.setBaby(true);
            zombie.moveTo(x, y, z, level.random.nextFloat() * 360f, 0f);
            level.addFreshEntity(zombie);
        } else {
            // An infested pumpkin: endermites, which bite and live two minutes
            // at most - never silverfish, which would hide in the stone for good.
            int mites = TRAP_MITES + trap.nextInt(2);
            for (int i = 0; i < mites; i++) {
                Endermite mite = EntityType.ENDERMITE.create(level, EntitySpawnReason.EVENT);
                if (mite == null || !level.noCollision(EntityType.ENDERMITE.getSpawnAABB(x, y, z))) return;
                mite.moveTo(x, y, z, level.random.nextFloat() * 360f, 0f);
                level.addFreshEntity(mite);
            }
        }
    }

    // ------------------------------------------------------------------ the blood night

    private static void bloodNight(MinecraftServer server, ServerLevel level, boolean night) {
        if (bloodActive) {
            if (!night) endBloodNight(server);
            return;
        }
        int key = settings.bloodKey();
        if (key == 0 || key == bloodDone || !night) return;
        long time = level.getDayTime() % 24_000L;
        // Only a night that has most of itself left, with somebody here to see it -
        // in any dimension, since the blood night reaches all of them.
        if (time > 18_000 || server.getPlayerList().getPlayers().isEmpty()) return;
        bloodActive = true;
        bloodDone = key;
        save();
        tell(server, HalloweenSettings.Line.BLOOD_START, ChatFormatting.DARK_RED);
    }

    private static void endBloodNight(MinecraftServer server) {
        bloodActive = false;
        tell(server, HalloweenSettings.Line.BLOOD_END, ChatFormatting.GRAY);
    }

    /** Every player online gets the line in their own language. */
    private static void tell(MinecraftServer server, HalloweenSettings.Line line, ChatFormatting style) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            player.sendSystemMessage(Component.literal(words(player, line)).withStyle(style));
        }
    }

    /** A line for one player, in their client's language. */
    private static String words(ServerPlayer player, HalloweenSettings.Line line) {
        return settings.words(line, player.clientInformation().language());
    }

    private static void fog(MinecraftServer server) {
        DustParticleOptions red = new DustParticleOptions(0x8A0303, 3.0f);
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            ServerLevel level = player.serverLevel();
            if (player.isSpectator()) continue;
            level.sendParticles(player, red, false, false, player.getX(), player.getY() + 1, player.getZ(), 10, 9, 2, 9, 0);
        }
    }

    // ------------------------------------------------------------------ the night's visitors

    private static void phantom(ServerLevel level, ServerPlayer player) {
        if (level.random.nextInt(PHANTOM_ODDS) != 0) return;
        if (phantomsAlive >= MAX_PHANTOMS) return;
        if (count(level, Phantom.class, player.getBoundingBox().inflate(64)) >= PHANTOMS_NEAR) return;
        RandomSource random = level.random;
        double x = player.getX() + random.nextInt(21) - 10;
        double y = player.getY() + 20 + random.nextInt(9);
        double z = player.getZ() + random.nextInt(21) - 10;
        if (y >= level.getMaxY() || !level.noCollision(EntityType.PHANTOM.getSpawnAABB(x, y, z))) return;
        Phantom phantom = EntityType.PHANTOM.create(level, EntitySpawnReason.EVENT);
        if (phantom == null) return;
        phantom.moveTo(x, y, z, random.nextFloat() * 360f, 0f);
        phantom.addTag(TAG);
        level.addFreshEntity(phantom);
        phantomsAlive++;
    }

    private static void trickOrTreater(ServerLevel level, ServerPlayer player) {
        if (level.random.nextInt(TRICK_ODDS) != 0) return;
        if (tricksAlive >= MAX_TRICKS) return;
        if (count(level, Villager.class, player.getBoundingBox().inflate(TRICK_NEAR)) > 0) return;
        BlockPos feet = openGround(level, player.blockPosition(), 8, 16, EntityType.VILLAGER);
        if (feet == null) return;
        Villager villager = EntityType.VILLAGER.create(level, EntitySpawnReason.EVENT);
        if (villager == null) return;
        villager.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, level.random.nextFloat() * 360f, 0f);
        // A nitwit takes no job: it is only visiting.
        villager.setVillagerData(villager.getVillagerData().setProfession(VillagerProfession.NITWIT));
        villager.setItemSlot(EquipmentSlot.HEAD, new ItemStack(level.random.nextBoolean() ? Items.CARVED_PUMPKIN : Items.JACK_O_LANTERN));
        villager.setDropChance(EquipmentSlot.HEAD, 0f);
        // A name over a head is seen by everybody at once, so it stays in the server's language.
        villager.setCustomName(Component.literal(settings.words(HalloweenSettings.Line.TRICK_NAME)).withStyle(ChatFormatting.GOLD));
        villager.setCustomNameVisible(true);
        villager.addTag(TAG);
        villager.addTag(TRICK_TAG);
        level.addFreshEntity(villager);
        tricksAlive++;
    }

    @SubscribeEvent
    public void onInteract(PlayerInteractEvent.EntityInteract event) {
        if (!(event.getTarget() instanceof Villager villager) || !villager.getTags().contains(TRICK_TAG)) return;
        event.setCanceled(true);
        event.setCancellationResult(InteractionResult.SUCCESS);
        if (event.getHand() != InteractionHand.MAIN_HAND || !(event.getEntity() instanceof ServerPlayer player)) return;
        if (!(villager.level() instanceof ServerLevel level)) return;
        ItemStack held = player.getItemInHand(InteractionHand.MAIN_HAND);
        if (!(held.is(Items.PUMPKIN) || held.is(Items.CARVED_PUMPKIN) || held.is(Items.JACK_O_LANTERN))) {
            player.displayClientMessage(Component.literal(words(player, HalloweenSettings.Line.TRICK_ASK)), true);
            return;
        }
        int given = treatsGiven.getOrDefault(villager.getUUID(), 0);
        if (given >= TRICK_TREATS) return;
        treatsGiven.put(villager.getUUID(), given + 1);
        if (!player.getAbilities().instabuild) held.shrink(1);
        RandomSource random = level.random;
        if (random.nextInt(100) < TRICK_SCARE_CHANCE) {
            player.addEffect(new MobEffectInstance(MobEffects.BLINDNESS, 60));
            level.playSound(null, villager.blockPosition(), SoundEvents.WITCH_CELEBRATE, SoundSource.NEUTRAL, 1f, 1f);
            player.displayClientMessage(Component.literal(words(player, HalloweenSettings.Line.TRICK_SCARE)).withStyle(ChatFormatting.DARK_PURPLE), true);
            return;
        }
        int roll = random.nextInt(100);
        ItemStack treat = roll < 45 ? new ItemStack(Items.COOKIE, 3)
                : roll < 80 ? new ItemStack(Items.PUMPKIN_PIE)
                : roll < 92 ? new ItemStack(Items.GOLDEN_CARROT)
                : new ItemStack(Items.EMERALD);
        if (!player.getInventory().add(treat)) player.drop(treat, false);
        level.playSound(null, villager.blockPosition(), SoundEvents.VILLAGER_YES, SoundSource.NEUTRAL, 1f, 1f);
        level.sendParticles(ParticleTypes.HAPPY_VILLAGER, villager.getX(), villager.getY() + 1.8, villager.getZ(), 6, 0.3, 0.3, 0.3, 0);
        player.displayClientMessage(Component.literal(words(player, HalloweenSettings.Line.TRICK_TREAT)).withStyle(ChatFormatting.GOLD), true);
    }

    private static void horseman(ServerLevel level, List<ServerPlayer> outside) {
        long night = level.getDayTime() / 24_000L;
        if (horsemanNight == night || level.random.nextInt(HORSEMAN_ODDS) != 0) return;
        if (horsemanAlive) return;
        ServerPlayer player = outside.get(level.random.nextInt(outside.size()));
        BlockPos feet = openGround(level, player.blockPosition(), 24, 40, EntityType.SKELETON_HORSE);
        if (feet == null) return;
        SkeletonHorse horse = EntityType.SKELETON_HORSE.create(level, EntitySpawnReason.EVENT);
        Skeleton rider = EntityType.SKELETON.create(level, EntitySpawnReason.EVENT);
        if (horse == null || rider == null) return;
        float yaw = level.random.nextFloat() * 360f;
        horse.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, yaw, 0f);
        horse.setTamed(true);
        horse.setAge(0);
        horse.addTag(TAG);
        horse.addTag(HORSEMAN_TAG);
        rider.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, yaw, 0f);
        rider.setItemSlot(EquipmentSlot.HEAD, new ItemStack(Items.JACK_O_LANTERN));
        rider.setDropChance(EquipmentSlot.HEAD, 0f);
        rider.setItemSlot(EquipmentSlot.MAINHAND, new ItemStack(Items.BOW));
        // A name over a head is seen by everybody at once, so it stays in the server's language.
        rider.setCustomName(Component.literal(settings.words(HalloweenSettings.Line.HORSEMAN)).withStyle(ChatFormatting.GOLD));
        rider.setCustomNameVisible(true);
        rider.addTag(TAG);
        rider.addTag(HORSEMAN_TAG);
        rider.startRiding(horse, true);
        level.addFreshEntityWithPassengers(horse);
        horsemanNight = night;
        horsemanAlive = true;
    }

    /** Somewhere open on natural ground a little way off, or null. */
    private static BlockPos openGround(ServerLevel level, BlockPos around, int min, int max, EntityType<?> type) {
        RandomSource random = level.random;
        for (int tries = 0; tries < 6; tries++) {
            double angle = random.nextDouble() * Math.PI * 2;
            int distance = min + random.nextInt(max - min + 1);
            int x = around.getX() + (int) Math.round(Math.cos(angle) * distance);
            int z = around.getZ() + (int) Math.round(Math.sin(angle) * distance);
            if (!level.hasChunk(x >> 4, z >> 4) || SeasonalDecor.isAvoided(x >> 4, z >> 4)) continue;
            BlockPos feet = new BlockPos(x, level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z), z);
            BlockPos ground = feet.below();
            BlockState under = level.getBlockState(ground);
            if (!SeasonalDecor.natural(under) || under.isAir() || under.is(BlockTags.LEAVES)) continue;
            if (!under.isFaceSturdy(level, ground, Direction.UP)) continue;
            if (!level.getBlockState(feet).isAir() || !level.getBlockState(feet.above()).isAir()) continue;
            if (!level.noCollision(type.getSpawnAABB(x + 0.5, feet.getY(), z + 0.5))) continue;
            return feet;
        }
        return null;
    }

    // ------------------------------------------------------------------ graves

    private static void graveyard(MinecraftServer server, ServerLevel level, List<ServerPlayer> outside) {
        int cap = GRAVEYARDS * settings.gravePercent() / 100;
        if (graveyards.size() >= cap || ticks - lastGraveTick < GRAVE_EVERY) return;
        lastGraveTick = ticks;
        RandomSource random = level.random;
        ServerPlayer player = outside.get(random.nextInt(outside.size()));
        for (int tries = 0; tries < 4; tries++) {
            double angle = random.nextDouble() * Math.PI * 2;
            int distance = GRAVE_MIN_DISTANCE + random.nextInt(GRAVE_MAX_DISTANCE - GRAVE_MIN_DISTANCE + 1);
            int x = player.getBlockX() + (int) Math.round(Math.cos(angle) * distance);
            int z = player.getBlockZ() + (int) Math.round(Math.sin(angle) * distance);
            Graveyard made = makeGraveyard(level, x, z, random);
            if (made == null) continue;
            graveyards.add(made);
            save();
            return;
        }
    }

    /** Three stones in a row and a chest before them, on wild grass with nothing built near, or null. */
    private static Graveyard makeGraveyard(ServerLevel level, int x, int z, RandomSource random) {
        for (Graveyard other : graveyards) {
            if (Math.abs(other.chest().getX() - x) < GRAVE_SPACING && Math.abs(other.chest().getZ() - z) < GRAVE_SPACING) return null;
        }
        int span = GRAVE_CLEAR_RADIUS + 2;
        for (int cx = (x - span) >> 4; cx <= (x + span) >> 4; cx++) {
            for (int cz = (z - span) >> 4; cz <= (z + span) >> 4; cz++) {
                if (!level.hasChunk(cx, cz) || SeasonalDecor.isAvoided(cx, cz)) return null;
            }
        }
        int y = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
        if (y <= level.getMinY()) return null;
        Direction along = random.nextBoolean() ? Direction.EAST : Direction.SOUTH;
        Direction front = along == Direction.EAST ? Direction.SOUTH : Direction.EAST;
        BlockPos center = new BlockPos(x, y, z);
        List<BlockPos> grounds = List.of(center.relative(along, -2), center, center.relative(along, 2), center.relative(front, 2));
        for (BlockPos ground : grounds) {
            if (level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, ground.getX(), ground.getZ()) - 1 != y) return null;
            if (!SeasonalDecor.naturalGrass(level, ground)) return null;
        }
        if (!wild(level, center)) return null;
        Block[] kinds = {Blocks.MOSSY_COBBLESTONE_WALL, Blocks.COBBLESTONE_WALL, Blocks.STONE_BRICK_WALL};
        List<BlockPos> stones = new ArrayList<>(3);
        for (int i = 0; i < 3; i++) {
            BlockPos stone = grounds.get(i).above();
            level.setBlock(stone, kinds[random.nextInt(kinds.length)].defaultBlockState(), Block.UPDATE_ALL);
            stones.add(stone);
        }
        BlockPos chestPos = grounds.get(3).above();
        level.setBlock(chestPos, Blocks.CHEST.defaultBlockState().setValue(ChestBlock.FACING, front), Block.UPDATE_ALL);
        Map<String, Integer> loot = new HashMap<>();
        if (level.getBlockEntity(chestPos) instanceof ChestBlockEntity chest) {
            Item[] items = {Items.BONE, Items.ROTTEN_FLESH, Items.IRON_NUGGET, Items.GOLD_NUGGET, Items.STRING,
                    Items.COOKIE, Items.PUMPKIN_PIE, Items.CANDLE};
            int stacks = 3 + random.nextInt(3);
            for (int i = 0; i < stacks; i++) {
                Item item = items[random.nextInt(items.length)];
                int amount = item == Items.PUMPKIN_PIE || item == Items.CANDLE ? 1 : 1 + random.nextInt(4);
                chest.setItem(random.nextInt(chest.getContainerSize()), new ItemStack(item, amount));
            }
            for (int slot = 0; slot < chest.getContainerSize(); slot++) {
                ItemStack stack = chest.getItem(slot);
                if (!stack.isEmpty()) loot.merge(itemId(stack.getItem()), stack.getCount(), Integer::sum);
            }
            chest.setChanged();
        }
        return new Graveyard(stones, chestPos, loot);
    }

    /** Nothing anybody built within reach of a graveyard: every block round it is one the world grew. */
    private static boolean wild(ServerLevel level, BlockPos center) {
        BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
        for (int dx = -GRAVE_CLEAR_RADIUS; dx <= GRAVE_CLEAR_RADIUS; dx += 2) {
            for (int dz = -GRAVE_CLEAR_RADIUS; dz <= GRAVE_CLEAR_RADIUS; dz += 2) {
                for (int dy = -1; dy <= GRAVE_CLEAR_HEIGHT; dy++) {
                    at.set(center.getX() + dx, center.getY() + dy, center.getZ() + dz);
                    if (!SeasonalDecor.natural(level.getBlockState(at))) return false;
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
    private static void takeGraveyardsDown(MinecraftServer server) {
        if (graveyards.isEmpty()) return;
        ServerLevel level = server.overworld();
        boolean changed = false;
        for (int i = graveyards.size() - 1; i >= 0; i--) {
            Graveyard graveyard = graveyards.get(i);
            boolean loadedHere = level.hasChunk(graveyard.chest().getX() >> 4, graveyard.chest().getZ() >> 4);
            for (BlockPos stone : graveyard.stones()) loadedHere &= level.hasChunk(stone.getX() >> 4, stone.getZ() >> 4);
            if (!loadedHere) continue;
            for (BlockPos stone : graveyard.stones()) {
                BlockState state = level.getBlockState(stone);
                if (state.is(Blocks.MOSSY_COBBLESTONE_WALL) || state.is(Blocks.COBBLESTONE_WALL) || state.is(Blocks.STONE_BRICK_WALL)) {
                    level.setBlock(stone, Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL);
                }
            }
            if (level.getBlockEntity(graveyard.chest()) instanceof ChestBlockEntity chest && onlyLoot(chest, graveyard.loot())) {
                chest.clearContent();
                level.setBlock(graveyard.chest(), Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL);
            }
            graveyards.remove(i);
            changed = true;
        }
        if (changed) save();
    }

    private static boolean onlyLoot(ChestBlockEntity chest, Map<String, Integer> loot) {
        Map<String, Integer> left = new HashMap<>(loot);
        for (int slot = 0; slot < chest.getContainerSize(); slot++) {
            ItemStack stack = chest.getItem(slot);
            if (stack.isEmpty()) continue;
            String id = itemId(stack.getItem());
            int allowed = left.getOrDefault(id, 0);
            if (stack.getCount() > allowed) return false;
            left.put(id, allowed - stack.getCount());
        }
        return true;
    }

    private static String itemId(Item item) {
        return BuiltInRegistries.ITEM.getKey(item).toString();
    }

    // ------------------------------------------------------------------ what is kept

    private static void load(MinecraftServer server) {
        loaded = true;
        stateFile = server.getWorldPath(LevelResource.ROOT).resolve(STATE_FILE);
        if (!Files.isRegularFile(stateFile)) return;
        try {
            JsonObject root = JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8)).getAsJsonObject();
            bloodDone = root.has("bloodDone") ? root.get("bloodDone").getAsInt() : 0;
            seasonEndsMillis = root.has("seasonEnds") ? root.get("seasonEnds").getAsLong() : 0;
            if (root.has("graveyards")) {
                for (JsonElement element : root.getAsJsonArray("graveyards")) {
                    JsonObject one = element.getAsJsonObject();
                    List<BlockPos> stones = new ArrayList<>();
                    for (JsonElement stone : one.getAsJsonArray("stones")) stones.add(BlockPos.of(stone.getAsLong()));
                    Map<String, Integer> loot = new HashMap<>();
                    for (Map.Entry<String, JsonElement> entry : one.getAsJsonObject("loot").entrySet()) {
                        if (ResourceLocation.tryParse(entry.getKey()) != null) loot.put(entry.getKey(), entry.getValue().getAsInt());
                    }
                    graveyards.add(new Graveyard(stones, BlockPos.of(one.get("chest").getAsLong()), loot));
                }
            }
        } catch (IOException | RuntimeException unreadable) {
            PolarisMod.LOG.warn("Polaris could not read {}; its graveyards stay where they are", stateFile, unreadable);
        }
    }

    /** Written beside the world, to a temporary name and moved over, so a crash never leaves half a file. */
    private static void save() {
        if (stateFile == null) return;
        JsonObject root = new JsonObject();
        root.addProperty("bloodDone", bloodDone);
        root.addProperty("seasonEnds", seasonEndsMillis);
        JsonArray list = new JsonArray();
        for (Graveyard graveyard : graveyards) {
            JsonObject one = new JsonObject();
            JsonArray stones = new JsonArray();
            for (BlockPos stone : graveyard.stones()) stones.add(stone.asLong());
            one.add("stones", stones);
            one.addProperty("chest", graveyard.chest().asLong());
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
            PolarisMod.LOG.warn("Polaris could not write {}", stateFile, failed);
        }
    }

    // ------------------------------------------------------------------ helpers

    private static <T extends Entity> int count(ServerLevel level, Class<T> type, AABB within) {
        return level.getEntitiesOfClass(type, within, entity -> entity.getTags().contains(TAG)).size();
    }

    /** The loaded entities this added, gathered first so they can be changed. */
    private static List<Entity> tagged(ServerLevel level) {
        List<Entity> found = new ArrayList<>();
        for (Entity entity : level.getAllEntities()) {
            if (entity != null && entity.getTags().contains(TAG)) found.add(entity);
        }
        return found;
    }
}
