package polaris.anticheat.api.events;

import polaris.anticheat.api.PolarisUser;

@Deprecated(since = "1.2.1.0", forRemoval = true)
public interface PolarisUserEvent {

    PolarisUser getUser();

    default PolarisUser getPlayer() {
        return getUser();
    }

}
