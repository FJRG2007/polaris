package polaris.anticheat.manager.tick.impl;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.manager.tick.Tickable;
import polaris.anticheat.player.PolarisPlayer;

public class TickInventory implements Tickable {
    @Override
    public void tick() {
        for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
            player.inventory.inventory.getInventoryStorage().tickWithBukkit();
        }
    }
}
