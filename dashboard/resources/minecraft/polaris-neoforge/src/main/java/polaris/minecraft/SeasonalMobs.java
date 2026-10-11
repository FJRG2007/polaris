package polaris.minecraft;

import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.entity.animal.SnowGolem;
import net.minecraft.world.entity.monster.AbstractSkeleton;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.monster.Phantom;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.AABB;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;
import net.neoforged.neoforge.event.entity.EntityMobGriefingEvent;
import net.neoforged.neoforge.event.entity.living.FinalizeSpawnEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/**
 * The season's mobs, alongside {@link SeasonalDecor}'s decorations.
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
 * Every mob this adds or dresses carries a tag, so the season ending, the
 * setting going to none, or a chunk loaded out of season puts it all back: the
 * pumpkins come off and the golems leave. Nothing else in the world is touched.
 *
 * Server thread only: the command, the events and the tick all run there.
 */
final class SeasonalMobs {
    /** The spawn setting that adds nothing, and the most either setting takes, in percent. */
    static final int USUAL = 100;
    static final int MAX_PERCENT = 400;

    /** On a mob wearing a seasonal pumpkin, and on a seasonal snow golem. */
    static final String HEAD_TAG = "polaris_season_head";
    static final String GOLEM_TAG = "polaris_season_golem";

    /** Zombies and skeletons that spawn at night wearing one, in percent. */
    private static final int HEAD_CHANCE = 75;
    /** Of those, the ones whose pumpkin is lit, in percent. */
    private static final int LIT_CHANCE = 35;
    /** What a mob's armour drops at when nothing set it otherwise. */
    private static final float USUAL_DROP_CHANCE = 0.085f;

    /** Extra spawns waiting, at most, and placed per tick. */
    private static final int EXTRA_QUEUE = 64;
    private static final int EXTRA_PER_TICK = 4;
    /** No extra where this many monsters are already about, within this many blocks. */
    private static final int CROWD = 24;
    private static final double CROWD_RADIUS = 32;
    /** No extra this close to a player, as the game's own spawns keep. */
    private static final double PLAYER_CLEARANCE = 24;

    /** Snow golems near a player at 100%, how far "near" is, and where they turn up. */
    private static final int GOLEMS_NEAR = 2;
    private static final double GOLEM_NEAR_RADIUS = 48;
    private static final int GOLEM_MIN_DISTANCE = 14;
    private static final int GOLEM_MAX_DISTANCE = 30;
    /** A golem with no player this near leaves. */
    private static final double GOLEM_LEAVE_DISTANCE = 96;
    /** One chance in this many per sweep per player that a golem turns up. */
    private static final int GOLEM_ODDS = 4;
    /** Of the golems, the ones that keep their pumpkin, in percent. */
    private static final int GOLEM_PUMPKIN_CHANCE = 40;

    private static final int SWEEP_TICKS = 200;

    private record Extra(ResourceKey<Level> dimension, EntityType<?> type, BlockPos pos) {}

    private static int spawns = USUAL;
    private static int golems;
    private static final ArrayDeque<Extra> extras = new ArrayDeque<>();
    /** Set while an extra is spawned, so it does not bring another. */
    private static boolean spawningExtra;
    private static int ticks;

    // ------------------------------------------------------------------ commands

    /** The settings that came with {@code polaris season set}. */
    static void configure(MinecraftServer server, int spawnPercent, int golemPercent) {
        spawns = Math.min(Math.max(spawnPercent, USUAL), MAX_PERCENT);
        golems = Math.min(Math.max(golemPercent, 0), MAX_PERCENT);
        if (spawns <= USUAL) extras.clear();
        if (golems == 0) sendGolemsAway(server, true);
    }

    /** Everything this added or dressed, put back: the season ended or changed. */
    static void revert(MinecraftServer server) {
        for (ServerLevel level : server.getAllLevels()) {
            for (Entity entity : tagged(level)) {
                if (entity.getTags().contains(GOLEM_TAG)) entity.discard();
                else if (entity instanceof Mob mob) takeHeadOff(mob);
            }
        }
        forget();
    }

    /** Back to nothing without touching the world. */
    static void forget() {
        spawns = USUAL;
        golems = 0;
        extras.clear();
    }

    static void status(JsonObject reply) {
        reply.addProperty("spawnPercent", spawns);
        reply.addProperty("golemPercent", golems);
        reply.addProperty("extrasWaiting", extras.size());
    }

    // ------------------------------------------------------------------ events

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onFinalizeSpawn(FinalizeSpawnEvent event) {
        if (SeasonalDecor.season() != SeasonalDecor.Season.HALLOWEEN || event.isSpawnCancelled()) return;
        if (event.getSpawnType() != EntitySpawnReason.NATURAL) return;
        ServerLevel level = event.getLevel().getLevel();
        if (level.dimension() != Level.OVERWORLD || !level.isNight()) return;
        Mob mob = event.getEntity();
        if (wearsHeads(mob) && mob.getItemBySlot(EquipmentSlot.HEAD).isEmpty()
                && level.random.nextInt(100) < HEAD_CHANCE) {
            putHeadOn(mob, level.random);
        }
        if (spawningExtra || spawns <= USUAL || !bringsExtras(mob)) return;
        int more = (spawns - USUAL) / 100;
        if (level.random.nextInt(100) < (spawns - USUAL) % 100) more++;
        for (int i = 0; i < more && extras.size() < EXTRA_QUEUE; i++) {
            extras.addLast(new Extra(level.dimension(), mob.getType(), BlockPos.containing(event.getX(), event.getY(), event.getZ())));
        }
    }

    /** A seasonal golem leaves no snow trail: the ground stays as it was. */
    @SubscribeEvent
    public void onGrief(EntityMobGriefingEvent event) {
        if (event.getEntity() instanceof SnowGolem golem && golem.getTags().contains(GOLEM_TAG)) event.setCanGrief(false);
    }

    /** A chunk loaded after the season ended, or by day, brings back nothing of it. */
    @SubscribeEvent
    public void onJoin(EntityJoinLevelEvent event) {
        if (!event.loadedFromDisk() || event.getLevel().isClientSide()) return;
        Entity entity = event.getEntity();
        if (entity.getTags().contains(GOLEM_TAG)) {
            if (SeasonalDecor.season() != SeasonalDecor.Season.WINTER || golems == 0) event.setCanceled(true);
        } else if (entity instanceof Mob mob && mob.getTags().contains(HEAD_TAG)) {
            if (SeasonalDecor.season() != SeasonalDecor.Season.HALLOWEEN || !event.getLevel().isNight()) takeHeadOff(mob);
        }
    }

    @SubscribeEvent
    public void onTick(ServerTickEvent.Post event) {
        if (SeasonalDecor.season() == null && extras.isEmpty()) return;
        MinecraftServer server = event.getServer();
        try {
            ticks++;
            placeExtras(server);
            if (ticks % SWEEP_TICKS == 0) sweep(server);
        } catch (RuntimeException failed) {
            // A tick must never fail over a seasonal mob: stop adding any until told again.
            PolarisMod.LOG.error("Polaris seasonal mobs failed and are off until told again", failed);
            forget();
        }
    }

    // ------------------------------------------------------------------ Halloween

    private static boolean wearsHeads(Mob mob) {
        return mob instanceof Zombie || mob instanceof AbstractSkeleton;
    }

    private static boolean bringsExtras(Mob mob) {
        return mob instanceof Monster && mob.getType().getCategory() == MobCategory.MONSTER && !(mob instanceof Phantom);
    }

    private static void putHeadOn(Mob mob, RandomSource random) {
        boolean lit = random.nextInt(100) < LIT_CHANCE;
        mob.setItemSlot(EquipmentSlot.HEAD, new ItemStack(lit ? Items.JACK_O_LANTERN : Items.CARVED_PUMPKIN));
        // Never dropped, so the season leaves nothing behind in anybody's chest.
        mob.setDropChance(EquipmentSlot.HEAD, 0f);
        mob.addTag(HEAD_TAG);
    }

    /** The seasonal pumpkin off, if it is still the one on: a helmet it picked up since stays. */
    private static void takeHeadOff(Mob mob) {
        ItemStack head = mob.getItemBySlot(EquipmentSlot.HEAD);
        if (head.is(Items.CARVED_PUMPKIN) || head.is(Items.JACK_O_LANTERN)) {
            mob.setItemSlot(EquipmentSlot.HEAD, ItemStack.EMPTY);
            mob.setDropChance(EquipmentSlot.HEAD, USUAL_DROP_CHANCE);
        }
        mob.removeTag(HEAD_TAG);
    }

    private static void placeExtras(MinecraftServer server) {
        for (int placed = 0; placed < EXTRA_PER_TICK && !extras.isEmpty(); placed++) {
            Extra extra = extras.removeFirst();
            if (SeasonalDecor.season() != SeasonalDecor.Season.HALLOWEEN) {
                extras.clear();
                return;
            }
            ServerLevel level = server.getLevel(extra.dimension());
            BlockPos pos = extra.pos();
            if (level == null || !level.isNight() || !level.hasChunk(pos.getX() >> 4, pos.getZ() >> 4)) continue;
            double x = pos.getX() + 0.5;
            double z = pos.getZ() + 0.5;
            if (level.getNearestPlayer(x, pos.getY(), z, PLAYER_CLEARANCE, false) != null) continue;
            if (level.getEntitiesOfClass(Monster.class, new AABB(pos).inflate(CROWD_RADIUS)).size() >= CROWD) continue;
            if (!level.noCollision(extra.type().getSpawnAABB(x, pos.getY(), z))) continue;
            spawningExtra = true;
            try {
                extra.type().spawn(level, pos, EntitySpawnReason.NATURAL);
            } finally {
                spawningExtra = false;
            }
        }
    }

    // ------------------------------------------------------------------ the sweep

    private static void sweep(MinecraftServer server) {
        ServerLevel overworld = server.overworld();
        if (!overworld.isNight() || SeasonalDecor.season() != SeasonalDecor.Season.HALLOWEEN) {
            for (Entity entity : tagged(overworld)) {
                if (entity instanceof Mob mob && mob.getTags().contains(HEAD_TAG)) takeHeadOff(mob);
            }
        }
        boolean winter = SeasonalDecor.season() == SeasonalDecor.Season.WINTER && golems > 0;
        sendGolemsAway(server, !winter);
        if (!winter) return;
        int cap = Math.max(1, Math.round(GOLEMS_NEAR * golems / 100f));
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            ServerLevel level = player.serverLevel();
            if (level.dimension() != Level.OVERWORLD || player.isSpectator()) continue;
            if (!cold(level, player.blockPosition())) continue;
            int near = level.getEntitiesOfClass(SnowGolem.class, player.getBoundingBox().inflate(GOLEM_NEAR_RADIUS),
                    golem -> golem.getTags().contains(GOLEM_TAG)).size();
            if (near >= cap || level.random.nextInt(GOLEM_ODDS) != 0) continue;
            BlockPos spot = golemSpot(level, player.blockPosition());
            if (spot != null) bringGolem(level, spot);
        }
    }

    /** Golems with nobody near leave, or every one of them with {@code all}. */
    private static void sendGolemsAway(MinecraftServer server, boolean all) {
        for (ServerLevel level : server.getAllLevels()) {
            for (Entity entity : tagged(level)) {
                if (!entity.getTags().contains(GOLEM_TAG)) continue;
                if (all || level.getNearestPlayer(entity, GOLEM_LEAVE_DISTANCE) == null) entity.discard();
            }
        }
    }

    private static boolean cold(ServerLevel level, BlockPos pos) {
        return level.getBiome(pos).value().coldEnoughToSnow(pos, level.getSeaLevel());
    }

    /** Somewhere cold, open and natural a little way off, or null. */
    private static BlockPos golemSpot(ServerLevel level, BlockPos around) {
        RandomSource random = level.random;
        for (int tries = 0; tries < 6; tries++) {
            double angle = random.nextDouble() * Math.PI * 2;
            int distance = GOLEM_MIN_DISTANCE + random.nextInt(GOLEM_MAX_DISTANCE - GOLEM_MIN_DISTANCE + 1);
            int x = around.getX() + (int) Math.round(Math.cos(angle) * distance);
            int z = around.getZ() + (int) Math.round(Math.sin(angle) * distance);
            if (!level.hasChunk(x >> 4, z >> 4) || SeasonalDecor.isAvoided(x >> 4, z >> 4)) continue;
            BlockPos feet = new BlockPos(x, level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z), z);
            BlockPos ground = feet.below();
            BlockState under = level.getBlockState(ground);
            BlockState at = level.getBlockState(feet);
            boolean naturalGround = under.is(Blocks.SNOW_BLOCK)
                    || (SeasonalDecor.natural(under) && !under.isAir() && !under.is(BlockTags.LEAVES));
            if (!naturalGround || !under.isFaceSturdy(level, ground, Direction.UP)) continue;
            if (!(at.isAir() || at.is(Blocks.SNOW)) || !level.getBlockState(feet.above()).isAir()) continue;
            if (!cold(level, feet)) continue;
            if (!level.noCollision(EntityType.SNOW_GOLEM.getSpawnAABB(x + 0.5, feet.getY(), z + 0.5))) continue;
            return feet;
        }
        return null;
    }

    private static void bringGolem(ServerLevel level, BlockPos feet) {
        SnowGolem golem = EntityType.SNOW_GOLEM.create(level, EntitySpawnReason.EVENT);
        if (golem == null) return;
        golem.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, level.random.nextFloat() * 360f, 0f);
        golem.setPumpkin(level.random.nextInt(100) < GOLEM_PUMPKIN_CHANCE);
        golem.addTag(GOLEM_TAG);
        level.addFreshEntity(golem);
    }

    /** The loaded entities carrying either seasonal tag, gathered first so they can be changed. */
    private static List<Entity> tagged(ServerLevel level) {
        List<Entity> found = new ArrayList<>();
        for (Entity entity : level.getAllEntities()) {
            if (entity != null && (entity.getTags().contains(HEAD_TAG) || entity.getTags().contains(GOLEM_TAG))) found.add(entity);
        }
        return found;
    }
}
