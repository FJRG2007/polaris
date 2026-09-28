package polaris.anticheat.utils.common;


import polaris.anticheat.api.config.ConfigManager;

public interface ConfigReloadObserver {

    void onReload(ConfigManager config);

}
