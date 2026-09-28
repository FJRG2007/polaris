package polaris.anticheat.platform.bukkit.initables;

import polaris.anticheat.manager.init.start.StartableInitable;
import polaris.anticheat.platform.bukkit.PolarisACBukkitLoaderPlugin;
import polaris.anticheat.platform.bukkit.events.PistonEvent;
import polaris.anticheat.utils.anticheat.LogUtil;
import org.bukkit.Bukkit;

public class BukkitEventManager implements StartableInitable {
    public void start() {
        LogUtil.info("Registering singular bukkit event... (PistonEvent)");

        Bukkit.getPluginManager().registerEvents(new PistonEvent(), PolarisACBukkitLoaderPlugin.LOADER);
    }
}
