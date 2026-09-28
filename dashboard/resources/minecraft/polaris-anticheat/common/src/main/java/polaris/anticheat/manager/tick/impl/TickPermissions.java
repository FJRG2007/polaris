package polaris.anticheat.manager.tick.impl;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.manager.config.BaseConfigManager;
import polaris.anticheat.manager.tick.Tickable;
import polaris.anticheat.player.PolarisPlayer;

public class TickPermissions implements Tickable {

    @Override
    public void tick() {
        BaseConfigManager config = PolarisAPI.INSTANCE.getConfigManager();
        int interval = config.getUpdatePermissionTicks();
        if (interval <= 0 || PolarisAPI.INSTANCE.getTickManager().currentTick % interval != 0) return;

        for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
            player.updatePermissions();
        }
    }
}
