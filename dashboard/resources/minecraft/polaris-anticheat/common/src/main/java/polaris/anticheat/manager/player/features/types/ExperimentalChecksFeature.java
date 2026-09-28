package polaris.anticheat.manager.player.features.types;

import polaris.anticheat.api.config.ConfigManager;
import polaris.anticheat.api.feature.FeatureState;
import polaris.anticheat.player.PolarisPlayer;

public class ExperimentalChecksFeature implements PolarisFeature {

    @Override
    public String getName() {
        return "ExperimentalChecks";
    }

    @Override
    public void setState(PolarisPlayer player, ConfigManager config, FeatureState state) {
        switch (state) {
            case ENABLED -> player.setExperimentalChecks(true);
            case DISABLED -> player.setExperimentalChecks(false);
            default -> player.setExperimentalChecks(isEnabledInConfig(player, config));
        }
    }

    @Override
    public boolean isEnabled(PolarisPlayer player) {
        return player.isExperimentalChecks();
    }

    @Override
    public boolean isEnabledInConfig(PolarisPlayer player, ConfigManager config) {
        return config.getBooleanElse("experimental-checks", false);
    }

}
