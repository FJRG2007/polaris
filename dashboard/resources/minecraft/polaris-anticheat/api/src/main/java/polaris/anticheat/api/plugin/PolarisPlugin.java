package polaris.anticheat.api.plugin;

import java.io.File;
import java.util.logging.Logger;

public interface PolarisPlugin {

    PolarisPluginDescription getDescription();

    Logger getLogger();

    File getDataFolder();
}
