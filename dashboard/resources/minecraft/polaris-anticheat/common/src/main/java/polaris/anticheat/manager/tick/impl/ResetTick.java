package polaris.anticheat.manager.tick.impl;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.manager.tick.Tickable;
import polaris.anticheat.player.PolarisPlayer;

public class ResetTick implements Tickable {
    @Override
    public void tick() {
        for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
            player.packetEntityReplication.tickStartTick();
        }
    }
}
