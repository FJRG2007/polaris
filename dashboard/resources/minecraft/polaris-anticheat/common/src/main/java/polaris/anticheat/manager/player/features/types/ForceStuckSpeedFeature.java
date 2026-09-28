package polaris.anticheat.manager.player.features.types;

import polaris.anticheat.api.config.ConfigManager;
import polaris.anticheat.api.feature.FeatureState;
import polaris.anticheat.player.PolarisPlayer;

public class ForceStuckSpeedFeature implements PolarisFeature {

    @Override
    public String getName() {
        return "ForceStuckSpeed";
    }

    @Override
    public void setState(PolarisPlayer player, ConfigManager config, FeatureState state) {
        switch (state) {
            case ENABLED -> player.setForceStuckSpeed(true);
            case DISABLED -> player.setForceStuckSpeed(false);
            default -> player.setForceStuckSpeed(isEnabledInConfig(player, config));
        }
    }

    @Override
    public boolean isEnabled(PolarisPlayer player) {
        return player.isForceStuckSpeed();
    }

    @Override
    public boolean isEnabledInConfig(PolarisPlayer player, ConfigManager config) {
        return config.getBooleanElse("force-stuck-speed", true);
    }

}
