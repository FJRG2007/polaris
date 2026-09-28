package polaris.anticheat.internal.platform.bukkit.resolver;

import polaris.anticheat.api.PolarisAPIProvider;
import polaris.anticheat.api.PolarisAbstractAPI;
import polaris.anticheat.api.plugin.BasicPolarisPlugin;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.internal.plugin.resolver.PolarisExtensionManager;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.PluginDescriptionFile;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages the registration of Bukkit-specific resolvers with the PolarisExtensionManager.
 * This class is designed to be instantiated once during plugin startup.
 */
public final class BukkitResolverRegistrar {

    // Cache to ensure we only create one PolarisPlugin wrapper per Bukkit Plugin instance.
    private final Map<Plugin, PolarisPlugin> pluginCache = new ConcurrentHashMap<>();

    /**
     * Registers all the Bukkit-specific resolvers in order of performance (fastest to slowest).
     */
    public void registerAll(PolarisExtensionManager extensionManager) {
        extensionManager.setFailureHandler(this::createFailureException);
        extensionManager.registerResolver(this::resolvePluginInstance);
        extensionManager.registerResolver(this::resolveStringName);
        extensionManager.registerResolver(this::resolveClass);
    }

    /**
     * The core logic for converting a Bukkit Plugin into a PolarisPlugin, with caching.
     */
    public PolarisPlugin resolvePlugin(Plugin bukkitPlugin) {
        return pluginCache.computeIfAbsent(bukkitPlugin, plugin -> {
            PluginDescriptionFile desc = plugin.getDescription();
            return new BasicPolarisPlugin(
                    plugin.getLogger(),
                    plugin.getDataFolder(),
                    desc.getVersion(),
                    desc.getDescription(),
                    desc.getAuthors()
            );
        });
    }

    /**
     * 1. Resolver for raw Plugin instances (the most common case).
     */
    private PolarisPlugin resolvePluginInstance(Object context) {
        if (context instanceof Plugin bukkitPlugin) {
            return resolvePlugin(bukkitPlugin);
        }
        return null;
    }

    /**
     * 2. Resolver for String plugin names.
     */
    private PolarisPlugin resolveStringName(Object context) {
        if (context instanceof String pluginName) {
            // Use the Bukkit API to look up the plugin by name. This returns null if not found.
            Plugin bukkitPlugin = Bukkit.getPluginManager().getPlugin(pluginName);
            // We must check for null before applying the logic to avoid a NullPointerException.
            return (bukkitPlugin != null) ? resolvePlugin(bukkitPlugin) : null;
        }
        return null;
    }

    /**
     * 3. Resolver for Class objects.
     */
    private PolarisPlugin resolveClass(Object context) {
        if (context instanceof Class) {
            try {
                // First, resolve the Class to a Plugin instance.
                JavaPlugin providingPlugin = JavaPlugin.getProvidingPlugin((Class<?>) context);
                // Then, use our shared logic directly to get the PolarisPlugin wrapper.
                return resolvePlugin(providingPlugin);
            } catch (IllegalArgumentException | IllegalStateException e) {
                // This is an expected failure if the class is not from a plugin
                // or is called from a static initializer. We simply indicate that
                // this resolver cannot handle this context.
                return null;
            }
        }
        // This resolver only handles Classes.
        return null;
    }

    private RuntimeException createFailureException(Object failedContext) {
        String message = """
        Failed to resolve PolarisPlugin context from the provided object of type '%s'.

        Please ensure you are passing one of the following:
          - The main instance of your plugin (e.g., 'this' from your class extending JavaPlugin).
          - The plugin name as a String (e.g., "MyPluginName").
          - Any Class from your plugin's JAR file (e.g., MyListener.class).
          - A pre-existing PolarisPlugin instance.
        """.formatted(failedContext.getClass().getName());
        return new IllegalArgumentException(message);
    }
}
