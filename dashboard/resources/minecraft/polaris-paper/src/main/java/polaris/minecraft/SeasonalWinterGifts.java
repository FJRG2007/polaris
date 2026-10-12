package polaris.minecraft;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Color;
import org.bukkit.GameMode;
import org.bukkit.HeightMap;
import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Barrel;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.data.Directional;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Zombie;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityTargetEvent;
import org.bukkit.inventory.EntityEquipment;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.BlockStateMeta;
import org.bukkit.inventory.meta.BundleMeta;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.inventory.meta.LeatherArmorMeta;
import org.bukkit.util.Vector;

/**
 * Christmas presents and mischievous elves. The same as the NeoForge mod's.
 *
 * A present is a barrel named for a player, set under a natural tree near them
 * with a few small things in it: one per player per day (the day on the
 * server's clock, as the dashboard says it), never where anything around was
 * built, and every one comes down when Christmas ends - those in a chunk that
 * is not loaded then come down when it next is, remembered across restarts in
 * {@link SeasonalWinterStore}.
 *
 * An elf is a baby zombie in green that steals one ordinary item (never
 * anything enchanted, named, damageable, holding other items, or on
 * {@link WinterPlan#valuable}) instead of hurting anybody, then runs. The item
 * goes into the store before it leaves the player's inventory, and is given back
 * to them whenever the elf that holds it is gone - caught, run off, unloaded,
 * or the server stopped - as soon as they are online and have room. Nothing an
 * elf takes is ever lost.
 */
final class SeasonalWinterGifts implements Listener {
    static final String ELF_TAG = "polaris_winter_elf";
    private static final String CARRYING_TAG = "polaris_winter_elf_carrying";

    private static final int PRESENT_ODDS = 6;
    private static final int REMOVE_PER_SWEEP = 16;
    private static final int ELVES_NEAR = 1;
    private static final int ELF_ODDS = 24;
    private static final int ELF_LIFE_TICKS = 3 * 60 * 20;
    private static final int ELF_RUN_TICKS = 60 * 20;
    private static final double ELF_HEALTH = 8;
    private static final int ELF_GREEN = 0x2E8B3A;
    private static final double NEAR = 48;

    private static final class Elf {
        final UUID entity;
        long bornTick;
        String holds;

        Elf(UUID entity, long bornTick) {
            this.entity = entity;
            this.bornTick = bornTick;
        }
    }

    private final SeasonalWinter winter;
    private final SeasonalWinterStore store;
    private final Random random = new Random();
    private final Map<UUID, Elf> elves = new HashMap<>();
    private final Map<UUID, Long> toldFull = new HashMap<>();
    private long ticks;

    SeasonalWinterGifts(SeasonalWinter winter, SeasonalWinterStore store) {
        this.winter = winter;
        this.store = store;
    }

    void forget() {
        elves.clear();
        toldFull.clear();
    }

    // ------------------------------------------------------------------ events

    /** An elf's hit takes an item instead of health. */
    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onHurt(EntityDamageByEntityEvent event) {
        if (!(event.getDamager() instanceof Zombie elf) || !elf.getScoreboardTags().contains(ELF_TAG)) return;
        event.setCancelled(true);
        if (!(event.getEntity() instanceof Player player) || elf.getScoreboardTags().contains(CARRYING_TAG)) return;
        Elf known = elves.get(elf.getUniqueId());
        if (known == null) return;
        // Let go of the player before the tag that refuses every new target.
        elf.setTarget(null);
        elf.addScoreboardTag(CARRYING_TAG);
        known.bornTick = ticks;
        ItemStack taken = steal(player, known);
        if (taken == null) {
            player.sendMessage(ChatColor.GREEN + words(player, WinterPlan.Line.ELF_FOUND_NOTHING));
            return;
        }
        EntityEquipment equipment = elf.getEquipment();
        if (equipment != null) {
            equipment.setItemInMainHand(taken.clone());
            equipment.setItemInMainHandDropChance(0f);
        }
        player.sendMessage(ChatColor.GREEN + words(player, WinterPlan.Line.ELF_STOLE, nameOf(taken)));
    }

    /** An elf with something runs: it chases nobody. */
    @EventHandler(ignoreCancelled = true)
    public void onTarget(EntityTargetEvent event) {
        if (event.getEntity().getScoreboardTags().contains(CARRYING_TAG)) event.setCancelled(true);
    }

    // ------------------------------------------------------------------ the sweep

    void sweep() {
        WinterPlan plan = SeasonalWinter.plan();
        if (store.data().getBoolean(SeasonalWinterStore.PRESENTS_GO)) takePresentsDown();
        for (Player player : Bukkit.getOnlinePlayers()) {
            World world = player.getWorld();
            if (world.getEnvironment() != World.Environment.NORMAL || player.getGameMode() == GameMode.SPECTATOR) continue;
            if (plan.presentsNow() && random.nextInt(PRESENT_ODDS) == 0) present(player);
            if (plan.elvesNow() && player.getGameMode() != GameMode.CREATIVE && random.nextInt(ELF_ODDS) == 0
                    && SeasonalWinter.near(player, ELF_TAG) < WinterPlan.cap(ELVES_NEAR, plan.elves())) {
                Block spot = winter.spot(world, player.getLocation().getBlock(), 10, 20, block -> true);
                if (spot != null) bringElf(spot);
            }
        }
    }

    /** Elves steered, sent off when their time is up, and what they held given back. Twice a second. */
    void elves() {
        ticks += 10;
        boolean wanted = SeasonalWinter.plan().elvesNow();
        List<UUID> gone = new ArrayList<>();
        for (Elf elf : elves.values()) {
            Entity entity = Bukkit.getEntity(elf.entity);
            if (!(entity instanceof Zombie zombie) || zombie.isDead() || !zombie.isValid()) {
                gone.add(elf.entity);
                continue;
            }
            boolean carrying = zombie.getScoreboardTags().contains(CARRYING_TAG);
            long life = carrying ? ELF_RUN_TICKS : ELF_LIFE_TICKS;
            if (!wanted || ticks - elf.bornTick > life || zombie.getWorld().getNearbyEntities(zombie.getLocation(),
                    2 * NEAR, 2 * NEAR, 2 * NEAR, other -> other instanceof Player).isEmpty()) {
                zombie.remove();
                gone.add(elf.entity);
                continue;
            }
            if (carrying) runFrom(zombie);
        }
        for (UUID id : gone) elves.remove(id);
        giveBack();
    }

    // ------------------------------------------------------------------ presents

    private void present(Player player) {
        WinterPlan plan = SeasonalWinter.plan();
        YamlConfiguration data = store.data();
        String who = GIFTED_PATH + player.getUniqueId();
        if (data.getInt(who) == plan.day()) return;
        Block spot = underATree(player.getWorld(), player.getLocation().getBlock());
        if (spot == null) return;
        spot.setType(Material.BARREL, true);
        if (spot.getBlockData() instanceof Directional facing) {
            facing.setFacing(BlockFace.UP);
            spot.setBlockData(facing, true);
        }
        if (!(spot.getState() instanceof Barrel barrel)) return;
        // Named for the one player it is for, so in that player's language.
        barrel.setCustomName(ChatColor.RED + words(player, WinterPlan.Line.PRESENT_FOR, player.getName()));
        fill(barrel.getSnapshotInventory());
        barrel.update(true, false);
        List<String> presents = new ArrayList<>(data.getStringList(SeasonalWinterStore.PRESENTS));
        presents.add(spot.getWorld().getUID() + ";" + spot.getX() + ";" + spot.getY() + ";" + spot.getZ());
        data.set(SeasonalWinterStore.PRESENTS, presents);
        data.set(who, plan.day());
        store.save();
        player.sendMessage(ChatColor.RED + words(player, WinterPlan.Line.PRESENT_WAITING));
    }

    private static final String GIFTED_PATH = SeasonalWinterStore.GIFTED + ".";

    /** A few small things: never anything worth more than a day's fun. */
    private void fill(Inventory inventory) {
        ItemStack[] choices = {
            new ItemStack(Material.COOKIE, 4 + random.nextInt(5)),
            new ItemStack(Material.SNOWBALL, 8 + random.nextInt(9)),
            new ItemStack(Material.SWEET_BERRIES, 4 + random.nextInt(5)),
            new ItemStack(Material.IRON_NUGGET, 3 + random.nextInt(7)),
            new ItemStack(Material.GOLD_NUGGET, 2 + random.nextInt(4)),
            new ItemStack(Material.COAL, 2 + random.nextInt(3)),
            new ItemStack(Material.PUMPKIN_PIE, 1 + random.nextInt(2)),
            SeasonalNewYear.rockets(1 + random.nextInt(3)),
        };
        int slot = 0;
        for (int i = 0; i < 3; i++) inventory.setItem(slot++, choices[random.nextInt(choices.length)].clone());
        if (random.nextInt(10) == 0) inventory.setItem(slot++, new ItemStack(Material.CAKE));
        if (random.nextInt(10) == 0) inventory.setItem(slot, new ItemStack(Material.EMERALD));
    }

    /** Beside the trunk of a natural tree a little way off, on natural ground, or null. */
    private Block underATree(World world, Block around) {
        for (int tries = 0; tries < 10; tries++) {
            int x = around.getX() + random.nextInt(49) - 24;
            int z = around.getZ() + random.nextInt(49) - 24;
            if (Math.abs(x - around.getX()) < 8 && Math.abs(z - around.getZ()) < 8) continue;
            if (!world.isChunkLoaded(x >> 4, z >> 4)) continue;
            Block at = world.getHighestBlockAt(x, z, HeightMap.MOTION_BLOCKING);
            if (!SeasonalDecor.wild(at.getBlockData())) continue;
            // Down through the leaves to a trunk, and down the trunk to its foot.
            for (int down = 0; down < 12 && Tag.LEAVES.isTagged(at.getType()); down++) at = at.getRelative(BlockFace.DOWN);
            if (!Tag.LOGS.isTagged(at.getType())) continue;
            for (int down = 0; down < 24 && Tag.LOGS.isTagged(at.getRelative(BlockFace.DOWN).getType()); down++)
                at = at.getRelative(BlockFace.DOWN);
            BlockFace[] sides = {BlockFace.NORTH, BlockFace.SOUTH, BlockFace.EAST, BlockFace.WEST};
            Block spot = at.getRelative(sides[random.nextInt(sides.length)]);
            if (!spot.getType().isAir() && !Tag.REPLACEABLE.isTagged(spot.getType())) continue;
            Material ground = spot.getRelative(BlockFace.DOWN).getType();
            if (!(Tag.DIRT.isTagged(ground) || ground == Material.SNOW_BLOCK)) continue;
            if (!wildAround(spot)) continue;
            return spot;
        }
        return null;
    }

    /** Nothing but natural blocks and the trees the game grew, in a 5x5 from one below to two above. */
    private static boolean wildAround(Block spot) {
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                for (int dy = -1; dy <= 2; dy++) {
                    Block block = spot.getRelative(dx, dy, dz);
                    Material type = block.getType();
                    if (!SeasonalDecor.natural(block) && !Tag.LOGS.isTagged(type) && type != Material.SNOW) return false;
                }
            }
        }
        return true;
    }

    /** Christmas over, or presents off: every present still standing comes down, a few at a time. */
    private void takePresentsDown() {
        YamlConfiguration data = store.data();
        List<String> presents = new ArrayList<>(data.getStringList(SeasonalWinterStore.PRESENTS));
        if (presents.isEmpty()) return;
        int removed = 0;
        for (int i = presents.size() - 1; i >= 0 && removed < REMOVE_PER_SWEEP; i--) {
            String[] parts = presents.get(i).split(";");
            World world = null;
            int x = 0, y = 0, z = 0;
            try {
                world = Bukkit.getWorld(UUID.fromString(parts[0]));
                x = Integer.parseInt(parts[1]);
                y = Integer.parseInt(parts[2]);
                z = Integer.parseInt(parts[3]);
            } catch (RuntimeException unreadable) {
                world = null;
            }
            if (world != null && !world.isChunkLoaded(x >> 4, z >> 4)) continue;
            // Whatever is still inside spills out where it stood: nobody's things go with it.
            if (world != null) {
                Block block = world.getBlockAt(x, y, z);
                if (block.getType() == Material.BARREL) block.breakNaturally();
            }
            presents.remove(i);
            removed++;
        }
        if (removed > 0) {
            data.set(SeasonalWinterStore.PRESENTS, presents);
            store.save();
        }
    }

    // ------------------------------------------------------------------ elves

    private void bringElf(Block feet) {
        Zombie spawned = feet.getWorld().spawn(feet.getLocation().add(0.5, 0, 0.5), Zombie.class, elf -> {
            elf.setBaby();
            elf.setCanPickupItems(false);
            EntityEquipment equipment = elf.getEquipment();
            if (equipment != null) {
                equipment.setHelmet(green(Material.LEATHER_HELMET));
                equipment.setChestplate(green(Material.LEATHER_CHESTPLATE));
                equipment.setLeggings(green(Material.LEATHER_LEGGINGS));
                equipment.setBoots(green(Material.LEATHER_BOOTS));
                equipment.setHelmetDropChance(0f);
                equipment.setChestplateDropChance(0f);
                equipment.setLeggingsDropChance(0f);
                equipment.setBootsDropChance(0f);
                equipment.setItemInMainHandDropChance(0f);
                equipment.setItemInOffHandDropChance(0f);
            }
            elf.setHealth(Math.min(ELF_HEALTH, elf.getHealth()));
            // A name over a head is seen by everybody at once, so it stays in the server's language.
            elf.setCustomName(ChatColor.GREEN + SeasonalWinter.plan().words(WinterPlan.Line.ELF));
            elf.addScoreboardTag(ELF_TAG);
        });
        elves.put(spawned.getUniqueId(), new Elf(spawned.getUniqueId(), ticks));
    }

    private static ItemStack green(Material material) {
        ItemStack stack = new ItemStack(material);
        if (stack.getItemMeta() instanceof LeatherArmorMeta meta) {
            meta.setColor(Color.fromRGB(ELF_GREEN));
            stack.setItemMeta(meta);
        }
        return stack;
    }

    /** A hop away from the nearest player. */
    private static void runFrom(Zombie elf) {
        Player nearest = null;
        double best = 32 * 32;
        for (Player player : elf.getWorld().getPlayers()) {
            double distance = player.getLocation().distanceSquared(elf.getLocation());
            if (distance < best) {
                best = distance;
                nearest = player;
            }
        }
        if (nearest == null || !elf.isOnGround()) return;
        Vector away = elf.getLocation().toVector().subtract(nearest.getLocation().toVector()).setY(0);
        if (away.lengthSquared() < 1.0E-4) away = new Vector(1, 0, 0);
        elf.setVelocity(away.normalize().multiply(0.45).setY(0.3));
    }

    /** One ordinary item from the player, written to the store first; null when there is none. */
    private ItemStack steal(Player player, Elf elf) {
        PlayerInventory inventory = player.getInventory();
        ItemStack[] storage = inventory.getStorageContents();
        List<Integer> ordinary = new ArrayList<>();
        for (int slot = 0; slot < storage.length; slot++) if (ordinary(storage[slot])) ordinary.add(slot);
        if (ordinary.isEmpty()) return null;
        int slot = ordinary.get(random.nextInt(ordinary.size()));
        ItemStack stack = storage[slot];
        ItemStack one = stack.clone();
        one.setAmount(1);
        String id = UUID.randomUUID().toString();
        YamlConfiguration data = store.data();
        String path = SeasonalWinterStore.OWED + "." + id;
        data.set(path + ".owner", player.getUniqueId().toString());
        data.set(path + ".item", one);
        if (!store.save()) {
            // Not written down, so not taken.
            data.set(path, null);
            return null;
        }
        stack.setAmount(stack.getAmount() - 1);
        inventory.setItem(slot, stack.getAmount() > 0 ? stack : null);
        elf.holds = id;
        return one;
    }

    private static boolean ordinary(ItemStack stack) {
        if (stack == null || stack.getType().isAir() || stack.getType().getMaxDurability() > 0) return false;
        if (!stack.getEnchantments().isEmpty()) return false;
        ItemMeta meta = stack.getItemMeta();
        if (meta != null && (meta.hasDisplayName() || meta.hasEnchants())) return false;
        if (meta instanceof BlockStateMeta block && block.hasBlockState()) return false;
        if (meta instanceof BundleMeta bundle && bundle.hasItems()) return false;
        return !WinterPlan.valuable(stack.getType().getKey().toString());
    }

    /** A line in the reader's own language, with a name where it has one. */
    private static String words(Player reader, WinterPlan.Line line, String... name) {
        String words = SeasonalWinter.plan().words(line, reader.getLocale());
        return name.length == 0 ? words : words.replace("%s", name[0]);
    }

    private static String nameOf(ItemStack stack) {
        ItemMeta meta = stack.getItemMeta();
        if (meta != null && meta.hasDisplayName()) return meta.getDisplayName();
        return stack.getType().getKey().getKey().replace('_', ' ');
    }

    /** Every item no live elf holds goes back to its owner, if they are online and have room. */
    private void giveBack() {
        YamlConfiguration data = store.data();
        ConfigurationSection owed = data.getConfigurationSection(SeasonalWinterStore.OWED);
        if (owed == null) return;
        List<String> held = new ArrayList<>();
        for (Elf elf : elves.values()) if (elf.holds != null) held.add(elf.holds);
        boolean changed = false;
        for (String id : owed.getKeys(false)) {
            if (held.contains(id)) continue;
            UUID owner;
            try {
                owner = UUID.fromString(owed.getString(id + ".owner", ""));
            } catch (IllegalArgumentException bad) {
                continue;
            }
            Player player = Bukkit.getPlayer(owner);
            ItemStack item = owed.getItemStack(id + ".item");
            if (player == null || item == null) continue;
            String name = nameOf(item);
            Map<Integer, ItemStack> left = player.getInventory().addItem(item);
            if (!left.isEmpty()) {
                owed.set(id + ".item", left.values().iterator().next());
                changed = true;
                long now = ticks;
                Long told = toldFull.get(owner);
                if (told == null || now - told > 600) {
                    toldFull.put(owner, now);
                    player.sendMessage(ChatColor.GREEN + words(player, WinterPlan.Line.ELF_NEEDS_ROOM, name));
                }
                continue;
            }
            owed.set(id, null);
            changed = true;
            player.sendMessage(ChatColor.GREEN + words(player, WinterPlan.Line.ELF_GAVE_BACK, name));
        }
        if (changed) store.save();
    }
}
