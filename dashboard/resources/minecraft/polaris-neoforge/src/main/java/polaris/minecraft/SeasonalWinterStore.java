package polaris.minecraft;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.Tag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.storage.LevelResource;

/**
 * What Christmas and New Year must remember across a restart, in
 * {@code world/polaris/winter.dat}: the presents placed (so they come down when
 * the season ends, even after a restart), who had today's present, the items
 * an elf is holding (so none is ever lost), and which midnights were already
 * celebrated (so nobody gets a gift twice).
 *
 * Written whole to a temporary name and moved over, like the event stashes:
 * never half a file. Server thread only.
 */
final class SeasonalWinterStore {
    static final String PRESENTS = "presents";
    static final String GIFTED = "gifted";
    static final String OWED = "owed";
    static final String EVE_DONE = "eveDone";
    static final String NEW_YEAR_DONE = "newYearDone";
    static final String SANTA_NIGHT = "santaNight";

    private static CompoundTag data;

    private SeasonalWinterStore() {}

    /** The store, read from disk the first time it is asked for after a start. */
    static CompoundTag data(MinecraftServer server) {
        if (data != null) return data;
        Path file = fileOf(server);
        CompoundTag read = null;
        if (Files.exists(file)) {
            try {
                read = NbtIo.readCompressed(file, NbtAccounter.unlimitedHeap());
            } catch (IOException failed) {
                // Kept aside rather than written over: it may hold items an elf owes somebody.
                PolarisMod.LOG.warn("Polaris could not read the winter store and set it aside: {}", failed.toString());
                setAside(file);
            }
        }
        data = read != null ? read : new CompoundTag();
        return data;
    }

    static ListTag list(MinecraftServer server, String key) {
        CompoundTag root = data(server);
        if (!root.contains(key, Tag.TAG_LIST)) root.put(key, new ListTag());
        return root.getList(key, Tag.TAG_COMPOUND);
    }

    static CompoundTag compound(MinecraftServer server, String key) {
        CompoundTag root = data(server);
        if (!root.contains(key, Tag.TAG_COMPOUND)) root.put(key, new CompoundTag());
        return root.getCompound(key);
    }

    /** Written now; false when the disk refused it, so a caller can undo what it was keeping. */
    static boolean save(MinecraftServer server) {
        if (data == null) return true;
        Path file = fileOf(server);
        try {
            Files.createDirectories(file.getParent());
            Path temporary = Files.createTempFile(file.getParent(), file.getFileName().toString(), ".tmp");
            try {
                NbtIo.writeCompressed(data, temporary);
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } finally {
                Files.deleteIfExists(temporary);
            }
            return true;
        } catch (IOException failed) {
            PolarisMod.LOG.error("Polaris could not write the winter store", failed);
            return false;
        }
    }

    /** Forgotten in memory when the server stops; the file stays for the next start. */
    static void unload() {
        data = null;
    }

    private static void setAside(Path file) {
        try {
            Files.move(file, file.resolveSibling("winter.dat.unreadable-" + System.currentTimeMillis()));
        } catch (IOException ignored) {
            // Left where it is; the next save replaces it.
        }
    }

    private static Path fileOf(MinecraftServer server) {
        return server.getWorldPath(LevelResource.ROOT).resolve("polaris").resolve("winter.dat");
    }
}
