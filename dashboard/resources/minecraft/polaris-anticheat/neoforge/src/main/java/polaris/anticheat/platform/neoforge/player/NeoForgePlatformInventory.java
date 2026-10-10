package polaris.anticheat.platform.neoforge.player;

import com.github.retrooper.packetevents.protocol.item.ItemStack;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.inventory.MenuType;
import org.jetbrains.annotations.Nullable;
import polaris.anticheat.platform.api.player.PlatformInventory;
import polaris.anticheat.platform.neoforge.utils.NeoForgeConversion;

/** The upstream Fabric platform's inventory, for 1.21.4. Slots are vanilla's. */
final class NeoForgePlatformInventory implements PlatformInventory {

    private final NeoForgePlatformPlayer player;

    NeoForgePlatformInventory(NeoForgePlatformPlayer player) {
        this.player = player;
    }

    private Inventory inventory() {
        return player.serverPlayer().getInventory();
    }

    @Override
    public ItemStack getItemInHand() {
        return NeoForgeConversion.fromNativeItemStack(inventory().getSelected());
    }

    @Override
    public ItemStack getItemInOffHand() {
        return NeoForgeConversion.fromNativeItemStack(inventory().getItem(40));
    }

    @Override
    public ItemStack getStack(int bukkitSlot, int vanillaSlot) {
        return NeoForgeConversion.fromNativeItemStack(inventory().getItem(bukkitSlot));
    }

    @Override
    public ItemStack getHelmet() {
        return NeoForgeConversion.fromNativeItemStack(inventory().getItem(39));
    }

    @Override
    public ItemStack getChestplate() {
        return NeoForgeConversion.fromNativeItemStack(inventory().getItem(38));
    }

    @Override
    public ItemStack getLeggings() {
        return NeoForgeConversion.fromNativeItemStack(inventory().getItem(37));
    }

    @Override
    public ItemStack getBoots() {
        return NeoForgeConversion.fromNativeItemStack(inventory().getItem(36));
    }

    @Override
    public ItemStack[] getContents() {
        Inventory inventory = inventory();
        ItemStack[] items = new ItemStack[inventory.getContainerSize()];
        for (int i = 0; i < items.length; i++) {
            items[i] = NeoForgeConversion.fromNativeItemStack(inventory.getItem(i));
        }
        return items;
    }

    @Override
    public String getOpenInventoryKey() {
        ServerPlayer serverPlayer = player.serverPlayer();
        AbstractContainerMenu menu = serverPlayer.containerMenu;
        MenuType<?> type = safeType(menu);
        if (type == null) {
            if (menu instanceof InventoryMenu) return "CRAFTING";
            if (serverPlayer.isCreative()) return "CREATIVE";
        }
        if (type == MenuType.CRAFTING) return "CRAFTING";
        if (type == MenuType.GENERIC_9x4) return "PLAYER";
        if (type == MenuType.GENERIC_9x3) return "CHEST";
        if (type == MenuType.GENERIC_3x3) return "DISPENSER";
        ResourceLocation key = type == null ? null : BuiltInRegistries.MENU.getKey(type);
        return key != null ? key.getPath() : menu.getClass().getSimpleName();
    }

    private static @Nullable MenuType<?> safeType(AbstractContainerMenu menu) {
        try {
            return menu.getType();
        } catch (UnsupportedOperationException e) {
            return null;
        }
    }
}
