package polaris.anticheat.platform.bukkit.manager;

import polaris.anticheat.platform.api.PlatformPlugin;
import polaris.anticheat.platform.api.manager.PlatformPluginManager;
import polaris.anticheat.platform.bukkit.BukkitPlatformPlugin;
import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;
import org.jetbrains.annotations.Nullable;

public class BukkitPlatformPluginManager implements PlatformPluginManager {

    @Override
    public PlatformPlugin[] getPlugins() {
        Plugin[] bukkitPlugins = Bukkit.getPluginManager().getPlugins();
        PlatformPlugin[] plugins = new PlatformPlugin[bukkitPlugins.length];

        for (int i = 0; i < bukkitPlugins.length; i++) {
            plugins[i] = new BukkitPlatformPlugin(bukkitPlugins[i]);
        }

        return plugins;
    }

    @Override
    public @Nullable PlatformPlugin getPlugin(String pluginName) {
        Plugin bukkitPlugin = Bukkit.getPluginManager().getPlugin(pluginName);
        return bukkitPlugin == null ? null : new BukkitPlatformPlugin(bukkitPlugin);
    }
}
