package polaris.minecraft;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.ai.attributes.AttributeInstance;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.Rarity;
import net.minecraft.world.item.component.DyedItemColor;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BarrelBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BarrelBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.living.LivingChangeTargetEvent;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;

/**
 * Christmas presents and mischievous elves.
 *
 * A present is a barrel named for a player, set under a natural tree near them
 * with a few small things in it: one per player per day (the day on the
 * server's clock, as the dashboard says it), never where anything around was
 * built, and every one comes down when Christmas ends - those in a chunk that
 * is not loaded then come down when it next is, remembered across restarts in
 * {@link SeasonalWinterStore}.
 *
 * An elf is a baby zombie in green that steals one ordinary item (never
 * anything enchanted, named, damageable, rare, holding other items, or on
 * {@link WinterPlan#valuable}) instead of hurting anybody, then runs. The item
 * goes into the store before it leaves the player's inventory, and is given back
 * to them whenever the elf that holds it is gone - caught, run off, unloaded,
 * or the server stopped - as soon as they are online and have room. Nothing an
 * elf takes is ever lost.
 *
 * Server thread only.
 */
final class SeasonalWinterGifts {
    static final String ELF_TAG = "polaris_winter_elf";
    private static final String CARRYING_TAG = "polaris_winter_elf_carrying";

    /** One chance in this many per sweep per player that their present is set out. */
    private static final int PRESENT_ODDS = 6;
    /** Presents taken down per sweep at the end of Christmas. */
    private static final int REMOVE_PER_SWEEP = 16;
    /** Elves near one player at 100%, and the odds per sweep one turns up. */
    private static final int ELVES_NEAR = 1;
    private static final int ELF_ODDS = 24;
    /** How long an elf stays, and how long it runs once it has something. */
    private static final int ELF_LIFE_TICKS = 3 * 60 * 20;
    private static final int ELF_RUN_TICKS = 60 * 20;
    private static final float ELF_HEALTH = 8f;
    private static final int ELF_GREEN = 0x2E8B3A;
    private static final double NEAR = 48;

    /** An elf in the world: the entity, when it came, and the store entry it holds, if any. */
    private static final class Elf {
        final UUID entity;
        final ResourceKey<Level> dimension;
        long bornTick;
        String holds;

        Elf(UUID entity, ResourceKey<Level> dimension, long bornTick) {
            this.entity = entity;
            this.dimension = dimension;
            this.bornTick = bornTick;
        }
    }

    private static final Map<UUID, Elf> elves = new HashMap<>();
    /** When a player was last told their inventory is too full to take an item back. */
    private static final Map<UUID, Long> toldFull = new HashMap<>();
    private static long ticks;

    /** Forgotten in memory when the server stops; the store keeps what is owed. */
    static void forget() {
        elves.clear();
        toldFull.clear();
    }

    // ------------------------------------------------------------------ events

    /** An elf's hit takes an item instead of health. */
    @SubscribeEvent
    public void onHurt(LivingIncomingDamageEvent event) {
        if (!(event.getSource().getEntity() instanceof Zombie elf) || !elf.getTags().contains(ELF_TAG)) return;
        event.setCanceled(true);
        if (!(event.getEntity() instanceof ServerPlayer player) || elf.getTags().contains(CARRYING_TAG)) return;
        Elf known = elves.get(elf.getUUID());
        if (known == null) return;
        // Let go of the player before the tag that refuses every new target.
        elf.setTarget(null);
        elf.addTag(CARRYING_TAG);
        known.bornTick = ticks;
        ItemStack taken = steal(player, known);
        if (taken.isEmpty()) {
            player.sendSystemMessage(Component.literal("An elf rummaged through your pockets and found nothing it wanted.")
                    .withStyle(ChatFormatting.GREEN));
            return;
        }
        elf.setItemSlot(EquipmentSlot.MAINHAND, taken.copy());
        elf.setDropChance(EquipmentSlot.MAINHAND, 0f);
        player.sendSystemMessage(Component.literal("An elf stole your " + taken.getHoverName().getString()
                + "! Catch it to get it back.").withStyle(ChatFormatting.GREEN));
    }

    /** An elf with something runs: it chases nobody. */
    @SubscribeEvent
    public void onTarget(LivingChangeTargetEvent event) {
        if (event.getEntity().getTags().contains(CARRYING_TAG)) event.setCanceled(true);
    }

    // ------------------------------------------------------------------ the sweep

    /** Presents set out and taken down, elves brought. Every few seconds. */
    static void sweep(MinecraftServer server) {
        WinterPlan plan = SeasonalWinter.plan();
        if (!plan.presentsNow()) takePresentsDown(server);
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            ServerLevel level = player.serverLevel();
            if (level.dimension() != Level.OVERWORLD || player.isSpectator()) continue;
            RandomSource random = level.random;
            if (plan.presentsNow() && random.nextInt(PRESENT_ODDS) == 0) present(server, player);
            if (plan.elvesNow() && !player.isCreative() && random.nextInt(ELF_ODDS) == 0
                    && elvesNear(level, player) < WinterPlan.cap(ELVES_NEAR, plan.elves())) {
                BlockPos spot = SeasonalWinter.spot(level, player.blockPosition(), 10, 20, EntityType.ZOMBIE, pos -> true);
                if (spot != null) bringElf(level, spot);
            }
        }
    }

    /** Elves steered, sent off when their time is up, and what they held given back. Twice a second. */
    static void elves(MinecraftServer server) {
        ticks += 10;
        boolean wanted = SeasonalWinter.plan().elvesNow();
        List<UUID> gone = new ArrayList<>();
        for (Elf elf : elves.values()) {
            ServerLevel level = server.getLevel(elf.dimension);
            Entity entity = level == null ? null : level.getEntity(elf.entity);
            if (!(entity instanceof Zombie zombie) || !zombie.isAlive()) {
                gone.add(elf.entity);
                continue;
            }
            boolean carrying = zombie.getTags().contains(CARRYING_TAG);
            long life = carrying ? ELF_RUN_TICKS : ELF_LIFE_TICKS;
            if (!wanted || ticks - elf.bornTick > life || level.getNearestPlayer(zombie, 2 * NEAR) == null) {
                zombie.discard();
                gone.add(elf.entity);
                continue;
            }
            if (carrying) runFrom(zombie, level);
        }
        for (UUID id : gone) elves.remove(id);
        giveBack(server);
    }

    private static int elvesNear(ServerLevel level, ServerPlayer player) {
        return level.getEntities((Entity) null, player.getBoundingBox().inflate(NEAR),
                entity -> entity.getTags().contains(ELF_TAG)).size();
    }

    // ------------------------------------------------------------------ presents

    private static void present(MinecraftServer server, ServerPlayer player) {
        WinterPlan plan = SeasonalWinter.plan();
        CompoundTag gifted = SeasonalWinterStore.compound(server, SeasonalWinterStore.GIFTED);
        String who = player.getUUID().toString();
        if (gifted.getInt(who) == plan.day()) return;
        ServerLevel level = player.serverLevel();
        BlockPos spot = underATree(level, player.blockPosition());
        if (spot == null) return;
        level.setBlock(spot, Blocks.BARREL.defaultBlockState().setValue(BarrelBlock.FACING, Direction.UP), 3);
        if (!(level.getBlockEntity(spot) instanceof BarrelBlockEntity barrel)) return;
        ItemStack named = new ItemStack(Items.BARREL);
        named.set(DataComponents.CUSTOM_NAME, Component.literal("Present for " + player.getName().getString())
                .withStyle(ChatFormatting.RED));
        barrel.applyComponentsFromItemStack(named);
        fill(barrel, level.random);
        barrel.setChanged();
        CompoundTag where = new CompoundTag();
        where.putString("dimension", level.dimension().location().toString());
        where.putInt("x", spot.getX());
        where.putInt("y", spot.getY());
        where.putInt("z", spot.getZ());
        SeasonalWinterStore.list(server, SeasonalWinterStore.PRESENTS).add(where);
        gifted.putInt(who, plan.day());
        SeasonalWinterStore.save(server);
        player.sendSystemMessage(Component.literal("A present is waiting for you under a tree nearby.")
                .withStyle(ChatFormatting.RED));
    }

    /** A few small things: never anything worth more than a day's fun. */
    private static void fill(BarrelBlockEntity barrel, RandomSource random) {
        ItemStack[] choices = {
            new ItemStack(Items.COOKIE, 4 + random.nextInt(5)),
            new ItemStack(Items.SNOWBALL, 8 + random.nextInt(9)),
            new ItemStack(Items.SWEET_BERRIES, 4 + random.nextInt(5)),
            new ItemStack(Items.IRON_NUGGET, 3 + random.nextInt(7)),
            new ItemStack(Items.GOLD_NUGGET, 2 + random.nextInt(4)),
            new ItemStack(Items.COAL, 2 + random.nextInt(3)),
            new ItemStack(Items.PUMPKIN_PIE, 1 + random.nextInt(2)),
            SeasonalNewYear.rockets(1 + random.nextInt(3)),
        };
        int slot = 0;
        for (int i = 0; i < 3; i++) barrel.setItem(slot++, choices[random.nextInt(choices.length)].copy());
        if (random.nextInt(10) == 0) barrel.setItem(slot++, new ItemStack(Items.CAKE));
        if (random.nextInt(10) == 0) barrel.setItem(slot, new ItemStack(Items.EMERALD));
    }

    /** Beside the trunk of a natural tree a little way off, on natural ground, or null. */
    private static BlockPos underATree(ServerLevel level, BlockPos around) {
        RandomSource random = level.random;
        for (int tries = 0; tries < 10; tries++) {
            int x = around.getX() + random.nextInt(49) - 24;
            int z = around.getZ() + random.nextInt(49) - 24;
            if (Math.abs(x - around.getX()) < 8 && Math.abs(z - around.getZ()) < 8) continue;
            if (!level.hasChunk(x >> 4, z >> 4) || SeasonalDecor.isAvoided(x >> 4, z >> 4)) continue;
            BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos(x, level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z) - 1, z);
            if (!SeasonalDecor.wild(level.getBlockState(at))) continue;
            // Down through the leaves to a trunk, and down the trunk to its foot.
            for (int down = 0; down < 12 && level.getBlockState(at).is(BlockTags.LEAVES); down++) at.move(Direction.DOWN);
            if (!level.getBlockState(at).is(BlockTags.LOGS)) continue;
            for (int down = 0; down < 24 && level.getBlockState(at.below()).is(BlockTags.LOGS); down++) at.move(Direction.DOWN);
            BlockPos foot = at.immutable();
            Direction side = Direction.from2DDataValue(random.nextInt(4));
            BlockPos spot = foot.relative(side);
            if (!level.getBlockState(spot).isAir() && !level.getBlockState(spot).is(BlockTags.REPLACEABLE)) continue;
            BlockState ground = level.getBlockState(spot.below());
            if (!(ground.is(BlockTags.DIRT) || ground.is(Blocks.SNOW_BLOCK))) continue;
            if (!wildAround(level, spot)) continue;
            return spot;
        }
        return null;
    }

    /** Nothing but natural blocks and the trees the game grew, in a 5x5 from one below to two above. */
    private static boolean wildAround(ServerLevel level, BlockPos spot) {
        BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                for (int dy = -1; dy <= 2; dy++) {
                    at.set(spot.getX() + dx, spot.getY() + dy, spot.getZ() + dz);
                    BlockState state = level.getBlockState(at);
                    if (!SeasonalDecor.natural(state) && !state.is(BlockTags.LOGS) && !state.is(Blocks.SNOW)) return false;
                }
            }
        }
        return true;
    }

    /** Christmas over, or presents off: every present still standing comes down, a few at a time. */
    private static void takePresentsDown(MinecraftServer server) {
        ListTag presents = SeasonalWinterStore.list(server, SeasonalWinterStore.PRESENTS);
        if (presents.isEmpty()) return;
        boolean changed = false;
        int removed = 0;
        for (int i = presents.size() - 1; i >= 0 && removed < REMOVE_PER_SWEEP; i--) {
            CompoundTag where = presents.getCompound(i);
            ResourceLocation id = ResourceLocation.tryParse(where.getString("dimension"));
            ServerLevel level = id == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, id));
            BlockPos pos = new BlockPos(where.getInt("x"), where.getInt("y"), where.getInt("z"));
            if (level != null && !level.hasChunk(pos.getX() >> 4, pos.getZ() >> 4)) continue;
            // Whatever is still inside spills out where it stood: nobody's things go with it.
            if (level != null && level.getBlockState(pos).is(Blocks.BARREL)) level.removeBlock(pos, false);
            presents.remove(i);
            removed++;
            changed = true;
        }
        if (changed) SeasonalWinterStore.save(server);
    }

    // ------------------------------------------------------------------ elves

    private static void bringElf(ServerLevel level, BlockPos feet) {
        Zombie elf = EntityType.ZOMBIE.create(level, EntitySpawnReason.EVENT);
        if (elf == null) return;
        elf.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, level.random.nextFloat() * 360f, 0f);
        elf.setBaby(true);
        elf.setCanPickUpLoot(false);
        elf.setItemSlot(EquipmentSlot.HEAD, green(Items.LEATHER_HELMET));
        elf.setItemSlot(EquipmentSlot.CHEST, green(Items.LEATHER_CHESTPLATE));
        elf.setItemSlot(EquipmentSlot.LEGS, green(Items.LEATHER_LEGGINGS));
        elf.setItemSlot(EquipmentSlot.FEET, green(Items.LEATHER_BOOTS));
        for (EquipmentSlot slot : EquipmentSlot.values()) elf.setDropChance(slot, 0f);
        AttributeInstance health = elf.getAttribute(Attributes.MAX_HEALTH);
        if (health != null) health.setBaseValue(ELF_HEALTH);
        elf.setHealth(ELF_HEALTH);
        elf.setCustomName(Component.literal("Elf").withStyle(ChatFormatting.GREEN));
        elf.addTag(ELF_TAG);
        if (level.addFreshEntity(elf)) elves.put(elf.getUUID(), new Elf(elf.getUUID(), level.dimension(), ticks));
    }

    private static ItemStack green(net.minecraft.world.item.Item item) {
        ItemStack stack = new ItemStack(item);
        stack.set(DataComponents.DYED_COLOR, new DyedItemColor(ELF_GREEN, false));
        return stack;
    }

    /** Away from the nearest player, a few blocks at a time. */
    private static void runFrom(Zombie elf, ServerLevel level) {
        var player = level.getNearestPlayer(elf, 32);
        if (player == null) return;
        Vec3 away = elf.position().subtract(player.position()).multiply(1, 0, 1);
        if (away.lengthSqr() < 1.0E-4) away = new Vec3(1, 0, 0);
        Vec3 to = elf.position().add(away.normalize().scale(10));
        elf.getNavigation().moveTo(to.x, to.y, to.z, 1.3);
    }

    /** One ordinary item from the player, written to the store first; empty when there is none. */
    private static ItemStack steal(ServerPlayer player, Elf elf) {
        MinecraftServer server = player.getServer();
        if (server == null) return ItemStack.EMPTY;
        Inventory inventory = player.getInventory();
        List<Integer> ordinary = new ArrayList<>();
        for (int slot = 0; slot < inventory.items.size(); slot++) {
            if (ordinary(inventory.items.get(slot))) ordinary.add(slot);
        }
        if (ordinary.isEmpty()) return ItemStack.EMPTY;
        int slot = ordinary.get(player.getRandom().nextInt(ordinary.size()));
        ItemStack one = inventory.items.get(slot).copyWithCount(1);
        HolderLookup.Provider registries = server.registryAccess();
        String id = UUID.randomUUID().toString();
        CompoundTag entry = new CompoundTag();
        entry.putString("id", id);
        entry.putString("owner", player.getUUID().toString());
        entry.put("item", one.save(registries));
        ListTag owed = SeasonalWinterStore.list(server, SeasonalWinterStore.OWED);
        owed.add(entry);
        if (!SeasonalWinterStore.save(server)) {
            // Not written down, so not taken.
            owed.remove(owed.size() - 1);
            return ItemStack.EMPTY;
        }
        inventory.items.get(slot).shrink(1);
        inventory.setChanged();
        elf.holds = id;
        return one;
    }

    private static boolean ordinary(ItemStack stack) {
        if (stack.isEmpty() || stack.isDamageableItem() || stack.isEnchanted()) return false;
        if (stack.getRarity() != Rarity.COMMON) return false;
        if (stack.has(DataComponents.CUSTOM_NAME) || stack.has(DataComponents.CONTAINER)
                || stack.has(DataComponents.BUNDLE_CONTENTS)) return false;
        return !WinterPlan.valuable(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
    }

    /** Every item no live elf holds goes back to its owner, if they are online and have room. */
    private static void giveBack(MinecraftServer server) {
        ListTag owed = SeasonalWinterStore.list(server, SeasonalWinterStore.OWED);
        if (owed.isEmpty()) return;
        List<String> held = new ArrayList<>();
        for (Elf elf : elves.values()) if (elf.holds != null) held.add(elf.holds);
        HolderLookup.Provider registries = server.registryAccess();
        boolean changed = false;
        for (int i = owed.size() - 1; i >= 0; i--) {
            CompoundTag entry = owed.getCompound(i);
            if (held.contains(entry.getString("id"))) continue;
            UUID owner;
            try {
                owner = UUID.fromString(entry.getString("owner"));
            } catch (IllegalArgumentException bad) {
                continue;
            }
            ServerPlayer player = server.getPlayerList().getPlayer(owner);
            if (player == null) continue;
            Optional<ItemStack> item = ItemStack.parse(registries, entry.getCompound("item"));
            if (item.isEmpty()) continue;
            ItemStack stack = item.get();
            String name = stack.getHoverName().getString();
            player.getInventory().add(stack);
            if (!stack.isEmpty()) {
                entry.put("item", stack.save(registries));
                changed = true;
                long now = server.getTickCount();
                Long told = toldFull.get(owner);
                if (told == null || now - told > 600) {
                    toldFull.put(owner, now);
                    player.sendSystemMessage(Component.literal("An elf is waiting to give back your " + name
                            + ". Make room in your inventory.").withStyle(ChatFormatting.GREEN));
                }
                continue;
            }
            owed.remove(i);
            changed = true;
            player.sendSystemMessage(Component.literal("You got your " + name + " back from the elf.")
                    .withStyle(ChatFormatting.GREEN));
        }
        if (changed) SeasonalWinterStore.save(server);
    }
}
