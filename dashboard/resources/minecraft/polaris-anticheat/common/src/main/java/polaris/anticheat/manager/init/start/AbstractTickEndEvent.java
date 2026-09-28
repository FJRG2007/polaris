package polaris.anticheat.manager.init.start;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.player.PolarisPlayer;

// Intended for future events we inject all platforms at the end of a tick
public abstract class AbstractTickEndEvent implements StartableInitable {

    @Override
    public void start() {

    }

    protected void onEndOfTick(PolarisPlayer player, boolean flush) {
        player.packetEntityReplication.onEndOfTickEvent(true, flush);
    }

    protected boolean shouldInjectEndTick() {
        return PolarisAPI.INSTANCE.getConfigManager().getConfig().getBooleanElse("Reach.enable-post-packet", false);
    }
}
