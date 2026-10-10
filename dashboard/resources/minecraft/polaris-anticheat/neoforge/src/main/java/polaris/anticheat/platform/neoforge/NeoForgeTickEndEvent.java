package polaris.anticheat.platform.neoforge;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.manager.init.start.AbstractTickEndEvent;
import polaris.anticheat.player.PolarisPlayer;

/** The upstream Fabric platform's end-of-tick hook, fed from NeoForge's server tick. */
final class NeoForgeTickEndEvent extends AbstractTickEndEvent {

    private volatile boolean active;

    @Override
    public void start() {
        active = super.shouldInjectEndTick();
    }

    void onEndOfServerTick() {
        if (!active) return;
        for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
            if (player.disablePolaris) continue;
            super.onEndOfTick(player, true);
        }
    }
}
