package polaris.anticheat.utils.inventory.slot;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.inventory.InventoryStorage;
import com.github.retrooper.packetevents.protocol.item.ItemStack;

public class ResultSlot extends Slot {

    public ResultSlot(InventoryStorage container, int slot) {
        super(container, slot);
    }

    @Override
    public boolean mayPlace(ItemStack itemStack) {
        return false;
    }

    @Override
    public void onTake(PolarisPlayer player, ItemStack itemStack) {
        // Resync the player's inventory
    }
}
