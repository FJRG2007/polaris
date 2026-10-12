package polaris.minecraft;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BiomeTags;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.RandomSource;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.animal.SnowGolem;
import net.minecraft.world.entity.animal.horse.Horse;
import net.minecraft.world.entity.animal.horse.Variant;
import net.minecraft.world.entity.npc.Villager;
import net.minecraft.world.entity.npc.VillagerProfession;
import net.minecraft.world.entity.npc.VillagerType;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.Snowball;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.trading.ItemCost;
import net.minecraft.world.item.trading.MerchantOffer;
import net.minecraft.world.item.trading.MerchantOffers;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;
import net.neoforged.neoforge.event.entity.EntityMobGriefingEvent;
import net.neoforged.neoforge.event.entity.ProjectileImpactEvent;
import net.neoforged.neoforge.event.server.ServerStoppedEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/**
 * Christmas and New Year's Eve, on top of the winter {@link SeasonalDecor} and
 * {@link SeasonalMobs} already bring, as the dashboard last said with
 * {@code polaris season winter key=value ...} ({@link WinterPlan}).
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
 *
 * Server thread only.
 */
final class SeasonalWinter {
    static final String GOLEM_TAG = "polaris_winter_golem";
    static final String REINDEER_TAG = "polaris_winter_reindeer";
    static final String SNOWMAN_TAG = "polaris_winter_snowman";
    static final String SANTA_TAG = "polaris_winter_santa";
    static final String SNOWBALL_TAG = "polaris_winter_snowball";

    private static final int SWEEP_TICKS = 100;
    private static final int SNOWMAN_TICKS = 10;
    /** How far "near a player" is when counting, and past which a visitor leaves. */
    private static final double NEAR = 48;
    private static final double LEAVE = 96;
    /** At 100%: golems and reindeer near one player, and the snowmen. */
    private static final int GOLEMS_NEAR = 2;
    private static final int REINDEER_NEAR = 4;
    private static final int SNOWMEN_NEAR = 1;
    /** One chance in this many per sweep per player that one turns up. */
    private static final int GOLEM_ODDS = 4;
    private static final int REINDEER_ODDS = 12;
    private static final int SNOWMAN_ODDS = 10;
    /** A snowman throws at a player this near, this often, and slows them this long. */
    private static final double THROW_RANGE = 14;
    private static final int THROW_TICKS = 30;
    private static final int SLOW_TICKS = 60;
    /** Santa arrives within this many blocks of a home, and only for a player this near it. */
    private static final double HOME_NEAR = 64;
    /** Santa's trades, each this many times. */
    private static final int SANTA_USES = 4;

    private static WinterPlan plan = WinterPlan.NONE;
    private static int ticks;

    /** What the dashboard last said; nothing on outside a winter. */
    static WinterPlan plan() {
        return plan;
    }

    // ------------------------------------------------------------------ commands

    /** {@code polaris season winter <key=value ...>}. */
    static JsonObject set(MinecraftServer server, String settings) {
        if (SeasonalDecor.season() != SeasonalDecor.Season.WINTER) return refused("notWinter");
        WinterPlan next;
        try {
            next = WinterPlan.parse(settings.trim().split("\\s+"));
        } catch (IllegalArgumentException bad) {
            return refused("usage");
        }
        WinterPlan before = plan;
        plan = next;
        presentsGo(server, !next.presentsNow());
        if (before.snow() != next.snow() || before.lights() != next.lights()) SeasonalDecor.redraw(server);
        return status();
    }

    static JsonObject status() {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("christmas", plan.christmas());
        reply.addProperty("day", plan.day());
        reply.addProperty("eveAt", plan.eveAt());
        reply.addProperty("newYearAt", plan.newYearAt());
        return reply;
    }

    private static JsonObject refused(String why) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", false);
        reply.addProperty("why", why);
        return reply;
    }

    // ------------------------------------------------------------------ events

    @SubscribeEvent
    public void onTick(ServerTickEvent.Post event) {
        MinecraftServer server = event.getServer();
        try {
            if (SeasonalDecor.season() != SeasonalDecor.Season.WINTER) {
                if (plan != WinterPlan.NONE) end(server);
                else if (SeasonalDecor.told()) presentsGo(server, true);
            }
            ticks++;
            if (plan != WinterPlan.NONE) SeasonalNewYear.tick(server);
            if (ticks % SNOWMAN_TICKS == 0) {
                if (plan != WinterPlan.NONE) snowmenThrow(server);
                SeasonalWinterGifts.elves(server);
            }
            if (ticks % SWEEP_TICKS == 0) {
                sweep(server);
                SeasonalWinterGifts.sweep(server);
            }
        } catch (RuntimeException failed) {
            // A tick must never fail over Christmas: stop bringing anything until told again.
            PolarisMod.LOG.error("Polaris Christmas and New Year failed and are off until told again", failed);
            plan = WinterPlan.NONE;
        }
    }

    /** A seasonal golem or snowman leaves no snow trail. */
    @SubscribeEvent
    public void onGrief(EntityMobGriefingEvent event) {
        Entity entity = event.getEntity();
        if (entity.getTags().contains(GOLEM_TAG) || entity.getTags().contains(SNOWMAN_TAG)) event.setCanGrief(false);
    }

    /** A chunk loaded after the winter, or by day, brings none of it back. */
    @SubscribeEvent
    public void onJoin(EntityJoinLevelEvent event) {
        if (!event.loadedFromDisk() || event.getLevel().isClientSide()) return;
        Entity entity = event.getEntity();
        boolean winter = SeasonalDecor.season() == SeasonalDecor.Season.WINTER;
        if (entity.getTags().contains(GOLEM_TAG)) {
            if (!winter || plan.golems() == 0) event.setCanceled(true);
        } else if (entity.getTags().contains(REINDEER_TAG)) {
            if (entity instanceof Horse horse && horse.isTamed()) horse.removeTag(REINDEER_TAG);
            else if (!winter || plan.reindeer() == 0) event.setCanceled(true);
        } else if (entity.getTags().contains(SNOWMAN_TAG) || entity.getTags().contains(SANTA_TAG)) {
            if (!winter || !event.getLevel().isNight()) event.setCanceled(true);
        } else if (entity.getTags().contains(SNOWBALL_TAG)) {
            event.setCanceled(true);
        } else if (entity.getTags().contains(SeasonalWinterGifts.ELF_TAG)) {
            // Its item, if it had one, is given back from the store.
            event.setCanceled(true);
        }
    }

    /** A grumpy snowman's snowball slows whoever it hits. */
    @SubscribeEvent
    public void onImpact(ProjectileImpactEvent event) {
        if (!event.getProjectile().getTags().contains(SNOWBALL_TAG)) return;
        if (event.getRayTraceResult() instanceof EntityHitResult hit && hit.getEntity() instanceof ServerPlayer player) {
            player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, SLOW_TICKS, 1));
        }
    }

    @SubscribeEvent
    public void onStopped(ServerStoppedEvent event) {
        plan = WinterPlan.NONE;
        SeasonalNewYear.forget();
        SeasonalWinterGifts.forget();
        SeasonalWinterStore.unload();
    }

    // ------------------------------------------------------------------ the sweep

    /** The winter over: everything it brought leaves, and what an elf holds goes back. */
    private static void end(MinecraftServer server) {
        plan = WinterPlan.NONE;
        SeasonalNewYear.forget();
        presentsGo(server, true);
        sendAway(server, entity -> true);
    }

    /** Whether the presents are to come down, kept across a restart: a jar not told yet keeps them. */
    private static void presentsGo(MinecraftServer server, boolean go) {
        CompoundTag data = SeasonalWinterStore.data(server);
        if (data.getBoolean(SeasonalWinterStore.PRESENTS_GO) == go) return;
        data.putBoolean(SeasonalWinterStore.PRESENTS_GO, go);
        SeasonalWinterStore.save(server);
    }

    private static void sweep(MinecraftServer server) {
        ServerLevel overworld = server.overworld();
        boolean night = overworld.isNight();
        sendAway(server, entity -> {
            if (entity.getTags().contains(GOLEM_TAG)) return plan.golems() == 0 || alone(entity);
            if (entity.getTags().contains(REINDEER_TAG)) {
                if (entity instanceof Horse horse && horse.isTamed()) {
                    horse.removeTag(REINDEER_TAG);
                    return false;
                }
                return plan.reindeer() == 0 || alone(entity);
            }
            if (entity.getTags().contains(SNOWMAN_TAG)) return plan.snowmen() == 0 || !night || alone(entity);
            if (entity.getTags().contains(SANTA_TAG)) return !plan.santaNow() || !night || aloneFor(entity, 2 * LEAVE);
            return false;
        });
        if (plan == WinterPlan.NONE) return;
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            ServerLevel level = player.serverLevel();
            if (level.dimension() != Level.OVERWORLD || player.isSpectator()) continue;
            BlockPos at = player.blockPosition();
            RandomSource random = level.random;
            if (plan.golems() > 0 && snowyVillageOrPlain(level, at) && random.nextInt(GOLEM_ODDS) == 0
                    && near(level, player, GOLEM_TAG) < WinterPlan.cap(GOLEMS_NEAR, plan.golems())) {
                BlockPos spot = spot(level, at, 14, 30, EntityType.SNOW_GOLEM, pos -> cold(level, pos));
                if (spot != null) bringGolem(level, spot, GOLEM_TAG, true);
            }
            if (plan.reindeer() > 0 && level.getBiome(at).is(BiomeTags.IS_TAIGA) && random.nextInt(REINDEER_ODDS) == 0) {
                int room = WinterPlan.cap(REINDEER_NEAR, plan.reindeer()) - near(level, player, REINDEER_TAG);
                BlockPos spot = room >= 2 ? spot(level, at, 20, 36, EntityType.HORSE, pos -> level.getBiome(pos).is(BiomeTags.IS_TAIGA)) : null;
                if (spot != null) bringHerd(level, spot, Math.min(room, 2 + random.nextInt(3)));
            }
            if (plan.snowmen() > 0 && night && random.nextInt(SNOWMAN_ODDS) == 0
                    && near(level, player, SNOWMAN_TAG) < WinterPlan.cap(SNOWMEN_NEAR, plan.snowmen())) {
                BlockPos spot = spot(level, at, 16, 28, EntityType.SNOW_GOLEM,
                        pos -> !level.getBiome(pos).is(BiomeTags.SNOW_GOLEM_MELTS));
                if (spot != null) bringGolem(level, spot, SNOWMAN_TAG, false);
            }
        }
        if (plan.santaNow() && night) santa(server, overworld);
    }

    private static boolean snowyVillageOrPlain(ServerLevel level, BlockPos at) {
        if (!cold(level, at)) return false;
        return level.getBiome(at).is(Biomes.SNOWY_PLAINS) || level.isVillage(at);
    }

    private static boolean cold(ServerLevel level, BlockPos pos) {
        return level.getBiome(pos).value().coldEnoughToSnow(pos, level.getSeaLevel());
    }

    private static boolean alone(Entity entity) {
        return aloneFor(entity, LEAVE);
    }

    private static boolean aloneFor(Entity entity, double distance) {
        return entity.level().getNearestPlayer(entity, distance) == null;
    }

    private static int near(ServerLevel level, ServerPlayer player, String tag) {
        return level.getEntities((Entity) null, player.getBoundingBox().inflate(NEAR), entity -> entity.getTags().contains(tag)).size();
    }

    /** Every loaded visitor this brought that should leave, gone. */
    private static void sendAway(MinecraftServer server, Predicate<Entity> leaves) {
        for (ServerLevel level : server.getAllLevels()) {
            List<Entity> going = new ArrayList<>();
            for (Entity entity : level.getAllEntities()) {
                if (entity == null) continue;
                boolean ours = entity.getTags().contains(GOLEM_TAG) || entity.getTags().contains(REINDEER_TAG)
                        || entity.getTags().contains(SNOWMAN_TAG) || entity.getTags().contains(SANTA_TAG);
                if (ours && leaves.test(entity)) going.add(entity);
            }
            for (Entity entity : going) entity.discard();
        }
    }

    /** Somewhere open, natural and standable a little way off, or null. */
    static BlockPos spot(ServerLevel level, BlockPos around, int min, int max, EntityType<?> type, Predicate<BlockPos> where) {
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
            BlockState at = level.getBlockState(feet);
            boolean naturalGround = under.is(Blocks.SNOW_BLOCK)
                    || (SeasonalDecor.natural(under) && !under.isAir() && !under.is(BlockTags.LEAVES));
            if (!naturalGround || !under.isFaceSturdy(level, ground, Direction.UP)) continue;
            if (!(at.isAir() || at.is(Blocks.SNOW)) || !level.getBlockState(feet.above()).isAir()) continue;
            if (!where.test(feet)) continue;
            if (!level.noCollision(type.getSpawnAABB(x + 0.5, feet.getY(), z + 0.5))) continue;
            return feet;
        }
        return null;
    }

    // ------------------------------------------------------------------ visitors

    private static void bringGolem(ServerLevel level, BlockPos feet, String tag, boolean pumpkin) {
        SnowGolem golem = EntityType.SNOW_GOLEM.create(level, EntitySpawnReason.EVENT);
        if (golem == null) return;
        golem.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, level.random.nextFloat() * 360f, 0f);
        golem.setPumpkin(pumpkin);
        golem.addTag(tag);
        // Names over heads are seen by everybody at once, so they stay in the server's language.
        if (!pumpkin) golem.setCustomName(Component.literal(plan.words(WinterPlan.Line.SNOWMAN)).withStyle(ChatFormatting.AQUA));
        level.addFreshEntity(golem);
    }

    private static void bringHerd(ServerLevel level, BlockPos feet, int count) {
        for (int i = 0; i < count; i++) {
            Horse reindeer = EntityType.HORSE.create(level, EntitySpawnReason.EVENT);
            if (reindeer == null) return;
            double x = feet.getX() + 0.5 + level.random.nextInt(5) - 2;
            double z = feet.getZ() + 0.5 + level.random.nextInt(5) - 2;
            reindeer.moveTo(x, feet.getY(), z, level.random.nextFloat() * 360f, 0f);
            if (!level.noCollision(reindeer)) {
                reindeer.discard();
                continue;
            }
            reindeer.setVariant(Variant.BROWN);
            reindeer.setCustomName(Component.literal(plan.words(WinterPlan.Line.REINDEER)));
            reindeer.addTag(REINDEER_TAG);
            level.addFreshEntity(reindeer);
        }
    }

    /** A grumpy snowman throws at the nearest player it can see. */
    private static void snowmenThrow(MinecraftServer server) {
        if (ticks % THROW_TICKS != 0) return;
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (player.isSpectator() || player.isCreative()) continue;
            ServerLevel level = player.serverLevel();
            for (Entity entity : level.getEntities((Entity) null, player.getBoundingBox().inflate(THROW_RANGE),
                    entity -> entity.getTags().contains(SNOWMAN_TAG))) {
                if (!(entity instanceof SnowGolem snowman) || !snowman.hasLineOfSight(player)) continue;
                Player target = level.getNearestPlayer(snowman, THROW_RANGE);
                if (target != player) continue;
                snowman.getLookControl().setLookAt(player);
                snowman.getNavigation().moveTo(player, 1.0);
                Snowball ball = new Snowball(level, snowman, new ItemStack(Items.SNOWBALL));
                Vec3 to = player.getEyePosition().subtract(ball.position());
                ball.shoot(to.x, to.y + to.horizontalDistance() * 0.2, to.z, 1.6f, 6f);
                ball.addTag(SNOWBALL_TAG);
                level.addFreshEntity(ball);
            }
        }
    }

    /** Once a night, Santa at one player's home, trading until sunrise. */
    private static void santa(MinecraftServer server, ServerLevel overworld) {
        long night = overworld.getDayTime() / 24_000L;
        if (SeasonalWinterStore.data(server).getLong(SeasonalWinterStore.SANTA_NIGHT) == night + 1) return;
        List<ServerPlayer> home = new ArrayList<>();
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            BlockPos bed = player.getRespawnPosition();
            if (bed == null || player.getRespawnDimension() != Level.OVERWORLD) continue;
            if (player.serverLevel() != overworld || player.isSpectator()) continue;
            if (player.blockPosition().closerThan(bed, HOME_NEAR)) home.add(player);
        }
        if (home.isEmpty()) return;
        ServerPlayer visited = home.get(overworld.random.nextInt(home.size()));
        BlockPos spot = standable(overworld, visited.getRespawnPosition());
        if (spot == null) return;
        Villager santa = EntityType.VILLAGER.create(overworld, EntitySpawnReason.EVENT);
        if (santa == null) return;
        santa.moveTo(spot.getX() + 0.5, spot.getY(), spot.getZ() + 0.5, overworld.random.nextFloat() * 360f, 0f);
        // A master already: never sent back to having no trade, and never levels up.
        santa.setVillagerData(santa.getVillagerData().setType(VillagerType.SNOW)
                .setProfession(VillagerProfession.CLERIC).setLevel(5));
        santa.setOffers(santaOffers());
        // A name over a head is seen by everybody at once, so it stays in the server's language.
        santa.setCustomName(Component.literal(plan.words(WinterPlan.Line.SANTA)).withStyle(ChatFormatting.RED, ChatFormatting.BOLD));
        santa.setCustomNameVisible(true);
        santa.setInvulnerable(true);
        santa.addTag(SANTA_TAG);
        overworld.addFreshEntity(santa);
        SeasonalWinterStore.data(server).putLong(SeasonalWinterStore.SANTA_NIGHT, night + 1);
        SeasonalWinterStore.save(server);
        visited.sendSystemMessage(Component.literal(plan.words(WinterPlan.Line.SANTA_VISITS, visited.clientInformation().language()))
                .withStyle(ChatFormatting.RED));
    }

    /** Somewhere a villager can stand within a few blocks of a home, or null. */
    private static BlockPos standable(ServerLevel level, BlockPos home) {
        RandomSource random = level.random;
        for (int tries = 0; tries < 12; tries++) {
            BlockPos feet = home.offset(random.nextInt(9) - 4, random.nextInt(3) - 1, random.nextInt(9) - 4);
            if (!level.hasChunk(feet.getX() >> 4, feet.getZ() >> 4)) continue;
            BlockPos ground = feet.below();
            if (!level.getBlockState(ground).isFaceSturdy(level, ground, Direction.UP)) continue;
            if (!level.getBlockState(feet).isAir() || !level.getBlockState(feet.above()).isAir()) continue;
            if (!level.noCollision(EntityType.VILLAGER.getSpawnAABB(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5))) continue;
            return feet;
        }
        return null;
    }

    private static MerchantOffers santaOffers() {
        MerchantOffers offers = new MerchantOffers();
        offers.add(new MerchantOffer(new ItemCost(Items.EMERALD, 1), new ItemStack(Items.COOKIE, 8), SANTA_USES, 0, 0.05f));
        offers.add(new MerchantOffer(new ItemCost(Items.EMERALD, 2), new ItemStack(Items.CAKE), SANTA_USES, 0, 0.05f));
        offers.add(new MerchantOffer(new ItemCost(Items.EMERALD, 2), SeasonalNewYear.rockets(4), SANTA_USES, 0, 0.05f));
        offers.add(new MerchantOffer(new ItemCost(Items.EMERALD, 1), new ItemStack(Items.SNOWBALL, 16), SANTA_USES, 0, 0.05f));
        offers.add(new MerchantOffer(new ItemCost(Items.EMERALD, 1), new ItemStack(Items.SPRUCE_SAPLING, 4), SANTA_USES, 0, 0.05f));
        offers.add(new MerchantOffer(new ItemCost(Items.EMERALD, 1), new ItemStack(Items.RED_WOOL, 8), SANTA_USES, 0, 0.05f));
        offers.add(new MerchantOffer(new ItemCost(Items.EMERALD, 1), new ItemStack(Items.GREEN_WOOL, 8), SANTA_USES, 0, 0.05f));
        return offers;
    }
}
