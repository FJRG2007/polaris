package polaris.anticheat.platform.bukkit.utils.placeholder;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.player.PolarisPlayer;
import me.clip.placeholderapi.expansion.PlaceholderExpansion;
import org.bukkit.OfflinePlayer;
import org.bukkit.entity.Player;
import org.jetbrains.annotations.NotNull;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

public class PlaceholderAPIExpansion extends PlaceholderExpansion {

    @Override
    public @NotNull String getIdentifier() {
        return "polarisac";
    }

    public @NotNull String getAuthor() {
        return String.join(", ", PolarisAPI.INSTANCE.getPolarisPlugin().getDescription().getAuthors());
    }

    @Override
    public @NotNull String getVersion() {
        return PolarisAPI.INSTANCE.getExternalAPI().getPolarisVersion();
    }

    @Override
    public boolean persist() {
        return true;
    }

    @Override
    public @NotNull List<String> getPlaceholders() {
        Set<String> staticReplacements = PolarisAPI.INSTANCE.getExternalAPI().getStaticReplacements().keySet();
        Set<String> variableReplacements = PolarisAPI.INSTANCE.getExternalAPI().getVariableReplacements().keySet();
        ArrayList<String> placeholders = new ArrayList<>(staticReplacements.size() + variableReplacements.size());
        for (String s : staticReplacements) {
            placeholders.add(s.equals("%polarisac_version%") ? s : "%polarisac_" + s.replace("%", "") + "%");
        }
        for (String s : variableReplacements) {
            placeholders.add(s.equals("%player%") ? "%polarisac_player%" : "%polarisac_player_" + s.replace("%", "") + "%");
        }
        return placeholders;
    }

    @Override
    public String onRequest(OfflinePlayer offlinePlayer, @NotNull String params) {
        for (Map.Entry<String, String> entry : PolarisAPI.INSTANCE.getExternalAPI().getStaticReplacements().entrySet()) {
            String key = entry.getKey().equals("%polarisac_version%")
                    ? "version"
                    : entry.getKey().replace("%", "");
            if (params.equalsIgnoreCase(key)) {
                return entry.getValue();
            }
        }

        if (offlinePlayer instanceof Player player) {
            PolarisPlayer polarisacPlayer = PolarisAPI.INSTANCE.getPlayerDataManager().getPlayer(player.getUniqueId());
            if (polarisacPlayer == null) return null;

            for (Map.Entry<String, Function<PolarisUser, String>> entry : PolarisAPI.INSTANCE.getExternalAPI().getVariableReplacements().entrySet()) {
                String key = entry.getKey().equals("%player%")
                        ? "player"
                        : "player_" + entry.getKey().replace("%", "");
                if (params.equalsIgnoreCase(key)) {
                    return entry.getValue().apply(polarisacPlayer);
                }
            }
        }

        return null;
    }
}
