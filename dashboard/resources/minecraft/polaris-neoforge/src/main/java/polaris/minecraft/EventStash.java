package polaris.minecraft;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.NonNullList;
import net.minecraft.core.component.DataComponents;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.Tag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.CraftingContainer;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.CustomData;
import net.minecraft.world.level.storage.LevelResource;
import net.neoforged.neoforge.attachment.AttachmentType;

/**
 * A player's things kept safe through an event, inside the server.
 *
 * {@code polaris stash save} takes every stack in the 41 slots (hotbar, bag,
 * armour, offhand - never the ender chest, never the event's own kit), and
 * every one a player could otherwise carry in out of sight of them: the stack
 * held on the cursor, what lies in a crafting grid (their own, or a table's
 * left open), and the trash slot a mod adds to the inventory screen
 * ({@link #TRASH}) - each kept as a loose stack ({@link #LOOSE}) that comes back
 * into any free slot, or at their feet as theirs. Once all that is taken an
 * open screen is closed, in the same tick: what one gives back on closing (an
 * anvil's, a grindstone's, a trade's) and what one throws down (a beacon's
 * payment) is kept in the same stash - the file written again, whole, before
 * it is taken ({@link #closeKeeping}). With their experience, health, hunger and
 * effects it is all written to a file of their own, and only then are the
 * slots and the experience emptied - all in one tick, so nothing
 * can be picked up or dropped halfway. {@code polaris stash restore} gives it
 * all back in one tick: each stack into the slot it came from, whatever the
 * player holds there now moved to a free slot, and what fits nowhere dropped at
 * their feet as theirs (nobody else can pick it up, it never despawns) - the
 * same rule the dashboard's own give-back keeps. Nothing is ever deleted.
 *
 * Crash safety: the file is written before anything is taken, and the player
 * carries a mark of the stash (a data attachment saved in their player file and
 * kept through death). Both change in the same tick, so after a crash the mark
 * says which side of the stash the player file is on:
 *
 * - mark and file: the stash happened and the player was saved emptied - give it.
 * - file, no mark: the player file is from before the stash (the crash came
 *   before the next save), so they still carry it all - the file is set aside
 *   as {@code .orphan}, never given twice and never deleted.
 *
 * A restored stash is renamed {@code .restored} and deleted once the player's
 * file is next written; a crash before that leaves the mark on the player, and
 * the next restore gives it again - from the renamed file.
 */
final class EventStash {
    /** The slots kept, in the game's own numbering (as the dashboard's `SLOTS`). */
    private static final int[] SLOTS = slots();
    /** A stack kept from no slot of the 41 - the cursor, a crafting grid, the
     *  trash slot - given back wherever there is room. */
    static final int LOOSE = -1000;
    /**
     * Where the trash slot mod keeps its one stack on a player: its library's
     * data under NeoForge's persisted player data, as an item stack's own tag
     * (empty for none). The mod empties it itself on every login.
     */
    private static final String PERSISTED = "PlayerPersisted";
    private static final String TRASH_OWNER = "BalmData";
    static final String TRASH = "TrashSlot";
    /** A key is a file name and an NBT path segment: no dots, no slashes. */
    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9_-]{1,64}");

    static Supplier<AttachmentType<CompoundTag>> marks;

    /** Restored stashes to delete once each player's file is written. */
    private static final Map<UUID, List<Path>> settled = new ConcurrentHashMap<>();

    /** What a screen a stash is closing throws, kept per player while it closes. */
    private static final Map<UUID, List<ItemStack>> closing = new ConcurrentHashMap<>();

    private EventStash() {}

    private static int[] slots() {
        int[] all = new int[41];
        for (int i = 0; i < 36; i++) all[i] = i;
        all[36] = 100;
        all[37] = 101;
        all[38] = 102;
        all[39] = 103;
        all[40] = -106;
        return all;
    }

    static boolean validKey(String key) {
        return KEY.matcher(key).matches();
    }

    // ------------------------------------------------------------------ save

    static JsonObject save(MinecraftServer server, String name, String key) {
        JsonObject reply = reply(key, name);
        ServerPlayer player = server.getPlayerList().getPlayerByName(name);
        if (player == null) return refuse(reply, "offline");
        if (player.isDeadOrDying()) return refuse(reply, "dead");
        CompoundTag mark = player.getData(marks);
        Path file = fileOf(server, key, "");
        if (mark.contains(key)) {
            // Saved already, and not given back: the same answer again.
            CompoundTag kept = read(file);
            reply.addProperty("ok", kept != null);
            reply.addProperty("already", true);
            if (kept == null) reply.addProperty("why", Files.exists(file) ? "unreadable" : "missing");
            else describe(reply, kept);
            return reply;
        }
        try {
            // A file left by a player whose own file was rolled back: kept aside.
            if (Files.exists(file)) setAside(file, fileOf(server, key, ".orphan"));
        } catch (IOException failed) {
            PolarisMod.LOG.warn("Polaris could not set an old stash aside: {}", failed.toString());
            return refuse(reply, "unsaved");
        }

        HolderLookup.Provider registries = server.registryAccess();
        Inventory inventory = player.getInventory();
        ListTag items = new ListTag();
        // Out of sight first: the cursor, every crafting grid and the trash slot.
        List<Runnable> emptied = new ArrayList<>();
        loose(player.containerMenu.getCarried(), registries, items, emptied, () -> player.containerMenu.setCarried(ItemStack.EMPTY));
        grids(player.inventoryMenu, registries, items, emptied);
        if (player.containerMenu != player.inventoryMenu) grids(player.containerMenu, registries, items, emptied);
        CompoundTag trash = trashOf(player);
        if (trash != null) {
            ItemStack trashed = ItemStack.parseOptional(registries, trash.getCompound(TRASH));
            loose(trashed, registries, items, emptied, () -> trash.put(TRASH, new CompoundTag()));
        }
        List<Integer> taken = new ArrayList<>();
        for (int slot : SLOTS) {
            ItemStack stack = get(inventory, slot);
            if (stack.isEmpty() || isKit(stack)) continue;
            CompoundTag entry = new CompoundTag();
            entry.putInt("slot", slot);
            entry.put("item", stack.save(registries));
            items.add(entry);
            taken.add(slot);
        }
        CompoundTag kept = new CompoundTag();
        kept.putString("player", player.getUUID().toString());
        kept.putString("name", player.getGameProfile().getName());
        kept.put("items", items);
        kept.putInt("levels", player.experienceLevel);
        kept.putInt("points", Math.round(player.experienceProgress * player.getXpNeededForNextLevel()));
        FoodData food = player.getFoodData();
        kept.putFloat("health", player.getHealth());
        kept.putInt("food", food.getFoodLevel());
        kept.putFloat("saturation", food.getSaturationLevel());
        ListTag effects = new ListTag();
        for (MobEffectInstance effect : player.getActiveEffects()) effects.add(effect.save());
        kept.put("effects", effects);
        try {
            write(file, kept);
        } catch (IOException failed) {
            PolarisMod.LOG.warn("Polaris could not write a stash: {}", failed.toString());
            return refuse(reply, "unsaved");
        }
        // Written: only now is anything taken.
        for (Runnable empty : emptied) empty.run();
        for (int slot : taken) set(inventory, slot, ItemStack.EMPTY);
        if (player.containerMenu != player.inventoryMenu) closeKeeping(player, file, kept, registries);
        player.setExperienceLevels(0);
        player.setExperiencePoints(0);
        CompoundTag next = mark.copy();
        next.putBoolean(key, true);
        player.setData(marks, next);
        player.inventoryMenu.broadcastChanges();
        player.containerMenu.broadcastChanges();
        reply.addProperty("ok", true);
        reply.addProperty("already", false);
        describe(reply, kept);
        return reply;
    }

    /**
     * Close the screen a stash found open, keeping what it gives back. An
     * anvil, a grindstone, a trade hands its inputs back into the bag just
     * emptied; a beacon throws its payment at the player's feet, where it would
     * lie behind them while they are away. Either is kept in the same stash, in
     * the same tick: written to the file again, whole, and only then taken.
     * Should that write fail, the bag keeps what came back (the dashboard's next
     * look stashes it) and what was thrown is put in it too.
     */
    private static void closeKeeping(ServerPlayer player, Path file, CompoundTag kept, HolderLookup.Provider registries) {
        List<ItemStack> thrown = new ArrayList<>();
        closing.put(player.getUUID(), thrown);
        try {
            player.closeContainer();
        } finally {
            closing.remove(player.getUUID());
        }
        Inventory inventory = player.getInventory();
        ListTag items = kept.getList("items", Tag.TAG_COMPOUND);
        ListTag more = items.copy();
        List<Integer> back = new ArrayList<>();
        for (int slot : SLOTS) {
            ItemStack stack = get(inventory, slot);
            if (stack.isEmpty() || isKit(stack)) continue;
            more.add(looseEntry(stack, registries));
            back.add(slot);
        }
        // Kit is the event's: back in the bag, for the event's own clear.
        List<ItemStack> theirs = new ArrayList<>();
        List<ItemStack> kit = new ArrayList<>();
        for (ItemStack stack : thrown) {
            if (stack.isEmpty()) continue;
            (isKit(stack) ? kit : theirs).add(stack);
        }
        giveOrDrop(player, kit);
        for (ItemStack stack : theirs) more.add(looseEntry(stack, registries));
        if (more.size() == items.size()) return;
        CompoundTag whole = kept.copy();
        whole.put("items", more);
        try {
            write(file, whole);
        } catch (IOException failed) {
            PolarisMod.LOG.warn("Polaris could not keep what a closed screen gave back: {}", failed.toString());
            giveOrDrop(player, theirs);
            return;
        }
        kept.put("items", more);
        for (int slot : back) set(inventory, slot, ItemStack.EMPTY);
    }

    /**
     * The stacks a stash's own close threw for a player, kept instead of thrown
     * ({@link EventCommands#onToss}): true when the throw is to be cancelled.
     */
    static boolean caught(UUID player, ItemStack stack) {
        List<ItemStack> into = closing.get(player);
        if (into == null) return false;
        into.add(stack.copy());
        return true;
    }

    // ------------------------------------------------------------------ restore

    static JsonObject restore(MinecraftServer server, String name, String key) {
        JsonObject reply = reply(key, name);
        ServerPlayer player = server.getPlayerList().getPlayerByName(name);
        if (player == null) return refuse(reply, "offline");
        if (player.isDeadOrDying()) return refuse(reply, "dead");
        CompoundTag mark = player.getData(marks);
        Path file = fileOf(server, key, "");
        Path restored = fileOf(server, key, ".restored");
        if (!mark.contains(key)) {
            reply.addProperty("ok", true);
            reply.addProperty("restored", false);
            if (Files.exists(file)) {
                // Their file is from before the stash: they still carry it all.
                try {
                    setAside(file, fileOf(server, key, ".orphan"));
                } catch (IOException failed) {
                    PolarisMod.LOG.warn("Polaris could not set a stash aside: {}", failed.toString());
                }
                reply.addProperty("why", "rolledBack");
            } else {
                reply.addProperty("why", Files.exists(restored) ? "already" : "none");
            }
            return reply;
        }
        // The mark and a renamed file: given back before a crash undid it.
        Path source = Files.exists(file) ? file : restored;
        if (!Files.exists(source)) return refuse(reply, "missing");
        CompoundTag kept = read(source);
        if (kept == null) return refuse(reply, "unreadable");

        HolderLookup.Provider registries = server.registryAccess();
        Inventory inventory = player.getInventory();
        ListTag items = kept.getList("items", Tag.TAG_COMPOUND);
        ListTag unread = new ListTag();
        List<ItemStack> displaced = new ArrayList<>();
        int slotted = 0;
        for (int i = 0; i < items.size(); i++) {
            CompoundTag entry = items.getCompound(i);
            Optional<ItemStack> stack = ItemStack.parse(registries, entry.getCompound("item"));
            if (stack.isEmpty()) {
                unread.add(entry);
                continue;
            }
            int slot = entry.getInt("slot");
            if (slot == LOOSE) {
                displaced.add(stack.get());
                continue;
            }
            ItemStack now = get(inventory, slot);
            // The event's kit still in the way is the event's to take, never a
            // stack to move or throw down as theirs: one thrown down outlives
            // the event, and the next one's clear takes it from whoever has it.
            if (!now.isEmpty() && !isKit(now)) displaced.add(now);
            set(inventory, slot, stack.get());
            slotted++;
        }
        int dropped = giveOrDrop(player, displaced);
        int moved = displaced.size() - dropped;
        player.giveExperienceLevels(kept.getInt("levels"));
        player.giveExperiencePoints(kept.getInt("points"));
        player.setHealth(Math.min(Math.max(kept.getFloat("health"), 1.0F), player.getMaxHealth()));
        FoodData food = player.getFoodData();
        food.setFoodLevel(kept.getInt("food"));
        food.setSaturation(kept.getFloat("saturation"));
        ListTag effects = kept.getList("effects", Tag.TAG_COMPOUND);
        for (int i = 0; i < effects.size(); i++) {
            MobEffectInstance effect = MobEffectInstance.load(effects.getCompound(i));
            if (effect != null) player.addEffect(effect);
        }
        player.inventoryMenu.broadcastChanges();
        CompoundTag next = mark.copy();
        next.remove(key);
        player.setData(marks, next);
        try {
            if (unread.isEmpty()) {
                if (source == file) setAside(file, restored);
                settled.computeIfAbsent(player.getUUID(), id -> new ArrayList<>()).add(restored);
            } else {
                // A stack this server cannot read any more (a mod taken out):
                // kept on disk for whoever can, never thrown away.
                kept.put("items", unread);
                write(fileOf(server, key, ".orphan"), kept);
                Files.deleteIfExists(file);
            }
        } catch (IOException failed) {
            PolarisMod.LOG.warn("Polaris could not settle a stash file: {}", failed.toString());
        }
        reply.addProperty("ok", true);
        reply.addProperty("restored", true);
        reply.addProperty("slotted", slotted);
        reply.addProperty("moved", moved);
        reply.addProperty("dropped", dropped);
        reply.addProperty("unread", unread.size());
        return reply;
    }

    /** A player's file was just written: their restored stashes can go. */
    static void playerSaved(UUID player) {
        List<Path> done = settled.remove(player);
        if (done == null) return;
        for (Path path : done) {
            try {
                Files.deleteIfExists(path);
            } catch (IOException failed) {
                PolarisMod.LOG.warn("Polaris could not delete a restored stash: {}", failed.toString());
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    /**
     * Each stack into any free slot, and what fits nowhere dropped at the
     * player's feet as theirs: nobody else can pick it up, and it never
     * despawns. Answers how many were dropped.
     */
    private static int giveOrDrop(ServerPlayer player, List<ItemStack> stacks) {
        Inventory inventory = player.getInventory();
        int dropped = 0;
        for (ItemStack stack : stacks) {
            inventory.add(stack);
            if (stack.isEmpty()) continue;
            ItemEntity drop = new ItemEntity(player.serverLevel(), player.getX(), player.getY(), player.getZ(), stack);
            drop.setTarget(player.getUUID());
            drop.setNoPickUpDelay();
            drop.setUnlimitedLifetime();
            player.serverLevel().addFreshEntity(drop);
            dropped++;
        }
        return dropped;
    }

    /** A stack kept loose, and how to empty where it came from once written. */
    private static void loose(ItemStack stack, HolderLookup.Provider registries, ListTag items, List<Runnable> emptied, Runnable empty) {
        if (stack.isEmpty() || isKit(stack)) return;
        items.add(looseEntry(stack, registries));
        emptied.add(empty);
    }

    private static CompoundTag looseEntry(ItemStack stack, HolderLookup.Provider registries) {
        CompoundTag entry = new CompoundTag();
        entry.putInt("slot", LOOSE);
        entry.put("item", stack.save(registries));
        return entry;
    }

    /** Every stack lying in a menu's crafting grid, kept loose. */
    private static void grids(AbstractContainerMenu menu, HolderLookup.Provider registries, ListTag items, List<Runnable> emptied) {
        for (Slot slot : menu.slots) {
            if (!(slot.container instanceof CraftingContainer)) continue;
            loose(slot.getItem(), registries, items, emptied, () -> slot.set(ItemStack.EMPTY));
        }
    }

    /** The trash slot mod's data on a player, or null where it keeps none. */
    static CompoundTag trashOf(ServerPlayer player) {
        CompoundTag data = player.getPersistentData();
        if (!data.contains(PERSISTED, Tag.TAG_COMPOUND)) return null;
        CompoundTag persisted = data.getCompound(PERSISTED);
        if (!persisted.contains(TRASH_OWNER, Tag.TAG_COMPOUND)) return null;
        CompoundTag owner = persisted.getCompound(TRASH_OWNER);
        return owner.contains(TRASH, Tag.TAG_COMPOUND) ? owner : null;
    }

    static boolean isKit(ItemStack stack) {
        CustomData data = stack.get(DataComponents.CUSTOM_DATA);
        return data != null && data.copyTag().getInt("polaris_event") == 1;
    }

    private static ItemStack get(Inventory inventory, int slot) {
        return list(inventory, slot).get(index(slot));
    }

    private static void set(Inventory inventory, int slot, ItemStack stack) {
        list(inventory, slot).set(index(slot), stack);
    }

    private static NonNullList<ItemStack> list(Inventory inventory, int slot) {
        if (slot >= 100) return inventory.armor;
        if (slot == -106) return inventory.offhand;
        return inventory.items;
    }

    private static int index(int slot) {
        if (slot >= 100) return slot - 100;
        if (slot == -106) return 0;
        return slot;
    }

    private static Path fileOf(MinecraftServer server, String key, String suffix) {
        return server.getWorldPath(LevelResource.ROOT).resolve("polaris").resolve("stash").resolve(key + suffix + ".dat");
    }

    /** Written whole to a temporary name and moved over: never half a file. */
    private static void write(Path file, CompoundTag tag) throws IOException {
        Files.createDirectories(file.getParent());
        Path temporary = Files.createTempFile(file.getParent(), file.getFileName().toString(), ".tmp");
        try {
            NbtIo.writeCompressed(tag, temporary);
            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static CompoundTag read(Path file) {
        if (!Files.exists(file)) return null;
        try {
            return NbtIo.readCompressed(file, NbtAccounter.unlimitedHeap());
        } catch (IOException failed) {
            PolarisMod.LOG.warn("Polaris could not read a stash: {}", failed.toString());
            return null;
        }
    }

    private static void setAside(Path from, Path to) throws IOException {
        Files.move(from, to, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    private static JsonObject reply(String key, String name) {
        JsonObject reply = new JsonObject();
        reply.addProperty("key", key);
        reply.addProperty("player", name);
        return reply;
    }

    private static JsonObject refuse(JsonObject reply, String why) {
        reply.addProperty("ok", false);
        reply.addProperty("why", why);
        return reply;
    }

    private static void describe(JsonObject reply, CompoundTag kept) {
        reply.addProperty("items", kept.getList("items", Tag.TAG_COMPOUND).size());
        reply.addProperty("levels", kept.getInt("levels"));
        reply.addProperty("points", kept.getInt("points"));
    }
}
