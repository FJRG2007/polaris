package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;

public interface PolarisUserEvent {
    PolarisUser getUser();
    default PolarisUser getPlayer() {
        return getUser();
    }
}

