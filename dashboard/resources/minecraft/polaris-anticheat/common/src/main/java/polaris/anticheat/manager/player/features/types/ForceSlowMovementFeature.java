package polaris.anticheat.manager.player.features.types;

import polaris.anticheat.api.config.ConfigManager;
import polaris.anticheat.api.feature.FeatureState;
import polaris.anticheat.player.PolarisPlayer;

public class ForceSlowMovementFeature implements PolarisFeature {

    @Override
    public String getName() {
        return "ForceSlowMovement";
    }

    @Override
    public void setState(PolarisPlayer player, ConfigManager config, FeatureState state) {
        switch (state) {
            case ENABLED -> player.setForceSlowMovement(true);
            case DISABLED -> player.setForceSlowMovement(false);
            default -> player.setForceSlowMovement(isEnabledInConfig(player, config));
        }
    }

    @Override
    public boolean isEnabled(PolarisPlayer player) {
        return player.isForceSlowMovement();
    }

    @Override
    public boolean isEnabledInConfig(PolarisPlayer player, ConfigManager config) {
        return config.getBooleanElse("force-slow-movement", true);
    }

}
