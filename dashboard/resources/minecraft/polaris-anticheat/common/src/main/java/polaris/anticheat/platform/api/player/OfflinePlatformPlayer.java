package polaris.anticheat.platform.api.player;

import polaris.anticheat.api.PolarisIdentity;

public interface OfflinePlatformPlayer extends PolarisIdentity {

    boolean isOnline();

    String getName();
}
