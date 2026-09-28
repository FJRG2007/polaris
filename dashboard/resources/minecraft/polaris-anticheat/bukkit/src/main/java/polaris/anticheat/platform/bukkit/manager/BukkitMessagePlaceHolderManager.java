package polaris.anticheat.platform.bukkit.manager;

import polaris.anticheat.platform.api.manager.MessagePlaceHolderManager;
import polaris.anticheat.platform.api.player.PlatformPlayer;
import polaris.anticheat.platform.bukkit.player.BukkitPlatformPlayer;
import polaris.anticheat.utils.reflection.ReflectionUtils;
import me.clip.placeholderapi.PlaceholderAPI;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

public class BukkitMessagePlaceHolderManager implements MessagePlaceHolderManager {
    public static final boolean hasPlaceholderAPI = ReflectionUtils.hasClass("me.clip.placeholderapi.PlaceholderAPI");

    @Override
    public @NotNull String replacePlaceholders(@Nullable PlatformPlayer player, @NotNull String string) {
        if (!hasPlaceholderAPI) return string;
        return PlaceholderAPI.setPlaceholders(player instanceof BukkitPlatformPlayer bukkitPlatformPlayer ? bukkitPlatformPlayer.getBukkitPlayer() : null, string);
    }
}
