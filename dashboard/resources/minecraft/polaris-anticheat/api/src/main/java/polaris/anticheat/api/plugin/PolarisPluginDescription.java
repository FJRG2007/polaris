package polaris.anticheat.api.plugin;

import org.jetbrains.annotations.NotNull;

import java.util.Collection;

public interface PolarisPluginDescription {
    String getVersion();

    String getDescription();

    public @NotNull Collection<String> getAuthors();
}
