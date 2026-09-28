package polaris.anticheat.manager.tick.impl;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.manager.tick.Tickable;
import polaris.anticheat.player.PolarisPlayer;

public class ClearRecentlyUpdatedBlocks implements Tickable {

    private static final int maxTickAge = 2;

    @Override
    public void tick() {
        for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
            player.blockHistory.cleanup(PolarisAPI.INSTANCE.getTickManager().currentTick - maxTickAge);
        }
    }
}
