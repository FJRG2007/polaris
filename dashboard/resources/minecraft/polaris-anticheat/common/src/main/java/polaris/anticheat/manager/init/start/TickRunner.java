package polaris.anticheat.manager.init.start;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.platform.api.Platform;
import polaris.anticheat.utils.anticheat.LogUtil;

public class TickRunner implements StartableInitable {
    @Override
    public void start() {
        LogUtil.info("Registering tick schedulers...");

        if (PolarisAPI.INSTANCE.getPlatform() == Platform.FOLIA) {
            PolarisAPI.INSTANCE.getScheduler().getAsyncScheduler().runAtFixedRate(PolarisAPI.INSTANCE.getPolarisPlugin(), () -> {
                PolarisAPI.INSTANCE.getTickManager().tickSync();
                PolarisAPI.INSTANCE.getTickManager().tickAsync();
            }, 1, 1);
        } else {
            PolarisAPI.INSTANCE.getScheduler().getGlobalRegionScheduler().runAtFixedRate(PolarisAPI.INSTANCE.getPolarisPlugin(), () -> PolarisAPI.INSTANCE.getTickManager().tickSync(), 0, 1);
            PolarisAPI.INSTANCE.getScheduler().getAsyncScheduler().runAtFixedRate(PolarisAPI.INSTANCE.getPolarisPlugin(), () -> PolarisAPI.INSTANCE.getTickManager().tickAsync(), 0, 1);
        }
    }
}
