package polaris.anticheat.manager.player.features.types;

import polaris.anticheat.api.config.ConfigManager;
import polaris.anticheat.api.feature.FeatureState;
import polaris.anticheat.player.PolarisPlayer;

public class ExemptElytraFeature implements PolarisFeature {

    @Override
    public String getName() {
        return "ExemptElytra";
    }

    @Override
    public void setState(PolarisPlayer player, ConfigManager config, FeatureState state) {
        switch (state) {
            case ENABLED -> player.setExemptElytra(true);
            case DISABLED -> player.setExemptElytra(false);
            default -> player.setExemptElytra(isEnabledInConfig(player, config));
        }
    }

    @Override
    public boolean isEnabled(PolarisPlayer player) {
        return player.isExemptElytra();
    }

    @Override
    public boolean isEnabledInConfig(PolarisPlayer player, ConfigManager config) {
        return config.getBooleanElse("exempt-elytra", false);
    }

}
