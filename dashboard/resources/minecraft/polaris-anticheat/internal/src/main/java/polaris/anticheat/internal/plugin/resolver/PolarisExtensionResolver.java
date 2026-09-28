package polaris.anticheat.internal.plugin.resolver;

import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;


/**
 * A functional interface responsible for attempting to resolve a generic context object
 * into a {@link PolarisPlugin}.
 * <p>
 * Implementations of this are provided by the core PolarisAC platform module (e.g., for Bukkit, Fabric)
 * and registered with the central PolarisExtensionManager.
 */
@FunctionalInterface
public interface PolarisExtensionResolver {

    /**
     * Attempts to resolve the given context object into a PolarisPlugin.
     *
     * @param context The context object to resolve (e.g., a Bukkit Plugin, a Plugin Class, a Fabric Mod).
     * @return A PolarisPlugin if this resolver supports the context type, otherwise null.
     */
    @Nullable PolarisPlugin resolve(@NotNull Object context);

}
