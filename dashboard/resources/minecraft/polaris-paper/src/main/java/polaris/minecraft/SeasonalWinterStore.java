package polaris.minecraft;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.plugin.Plugin;

/**
 * What Christmas and New Year must remember across a restart, in the plugin's
 * {@code winter.yml}: the presents placed (so they come down when the season
 * ends, even after a restart), who had today's present, the items an elf is
 * holding (so none is ever lost), and which midnights were already celebrated
 * (so nobody gets a gift twice).
 *
 * Written whole to a temporary name and moved over: never half a file.
 * Server thread only.
 */
final class SeasonalWinterStore {
    static final String PRESENTS = "presents";
    static final String GIFTED = "gifted";
    static final String OWED = "owed";
    static final String EVE_DONE = "eveDone";
    static final String NEW_YEAR_DONE = "newYearDone";
    static final String SANTA_NIGHT = "santaNight";

    private final Plugin plugin;
    private YamlConfiguration data;

    SeasonalWinterStore(Plugin plugin) {
        this.plugin = plugin;
    }

    /** The store, read from disk the first time it is asked for. */
    YamlConfiguration data() {
        if (data != null) return data;
        data = new YamlConfiguration();
        Path file = file();
        if (Files.exists(file)) {
            try {
                data.loadFromString(Files.readString(file, StandardCharsets.UTF_8));
            } catch (IOException | InvalidConfigurationException failed) {
                // Kept aside rather than written over: it may hold items an elf owes somebody.
                plugin.getLogger().warning("Polaris could not read the winter store and set it aside: " + failed);
                data = new YamlConfiguration();
                try {
                    Files.move(file, file.resolveSibling("winter.yml.unreadable-" + System.currentTimeMillis()));
                } catch (IOException ignored) {
                    // Left where it is; the next save replaces it.
                }
            }
        }
        return data;
    }

    /** Written now; false when the disk refused it, so a caller can undo what it was keeping. */
    boolean save() {
        if (data == null) return true;
        Path file = file();
        try {
            Files.createDirectories(file.getParent());
            Path temporary = Files.createTempFile(file.getParent(), "winter", ".tmp");
            try {
                Files.writeString(temporary, data.saveToString(), StandardCharsets.UTF_8);
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } finally {
                Files.deleteIfExists(temporary);
            }
            return true;
        } catch (IOException failed) {
            plugin.getLogger().severe("Polaris could not write the winter store: " + failed);
            return false;
        }
    }

    private Path file() {
        return plugin.getDataFolder().toPath().resolve("winter.yml");
    }
}
