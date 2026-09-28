package polaris.anticheat.manager.player.features.types;

import polaris.anticheat.api.config.ConfigManager;
import polaris.anticheat.api.feature.FeatureState;
import polaris.anticheat.player.PolarisPlayer;

public interface PolarisFeature {
    String getName();

    void setState(PolarisPlayer player, ConfigManager config, FeatureState state);

    boolean isEnabled(PolarisPlayer player);

    boolean isEnabledInConfig(PolarisPlayer player, ConfigManager config);
}
