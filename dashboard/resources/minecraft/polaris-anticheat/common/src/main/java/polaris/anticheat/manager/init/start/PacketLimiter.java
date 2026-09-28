package polaris.anticheat.manager.init.start;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.player.PolarisPlayer;

public class PacketLimiter implements StartableInitable {
    @Override
    public void start() {
        PolarisAPI.INSTANCE.getScheduler().getAsyncScheduler().runAtFixedRate(PolarisAPI.INSTANCE.getPolarisPlugin(), () -> {
            for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
                // Avoid concurrent reading on an integer as it's results are unknown
                player.cancelledPackets.set(0);
            }
        }, 1, 20);
    }
}
