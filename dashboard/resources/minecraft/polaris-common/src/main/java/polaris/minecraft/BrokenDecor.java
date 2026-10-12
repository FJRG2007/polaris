package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.Set;

/**
 * The seasonal decorations players knocked down, so one knocked down stays down.
 *
 * A decoration is only shown, never set, and is decided again from the world's
 * seed whenever a player's game needs it - after a relog, a trip away, a
 * restart. Without this list every decoration a player broke came back. The
 * positions are block positions packed into a long by the caller. One season's
 * list is dropped when another season is told, or once it is older than any
 * season lasts, so next year's pumpkins stand where this year's were broken.
 *
 * Kept beside the world, so it outlives a restart. Not thread-safe: the server
 * thread owns it.
 */
final class BrokenDecor {
    /** Longer than any season lasts, well short of the year until it comes back. */
    static final long KEPT_MILLIS = 120L * 24 * 60 * 60 * 1000;
    /** The most remembered; past it, a decoration broken later may come back after a restart. */
    static final int MOST = 50_000;

    private final Set<Long> positions = new HashSet<>();
    private String season = "";
    private long since;

    /**
     * Ready for {@code next} at {@code now}: a list from another season, or one
     * older than {@link #KEPT_MILLIS}, is dropped. True when anything changed,
     * which is when the list needs writing.
     */
    boolean keepFor(String next, long now) {
        if (season.equals(next) && now - since <= KEPT_MILLIS) return false;
        positions.clear();
        season = next;
        since = now;
        return true;
    }

    boolean contains(long position) {
        return positions.contains(position);
    }

    /** Remembered from now on; false when it already was, or the list is full. */
    boolean add(long position) {
        return positions.size() < MOST && positions.add(position);
    }

    int size() {
        return positions.size();
    }

    String toJson() {
        JsonObject root = new JsonObject();
        root.addProperty("season", season);
        root.addProperty("since", since);
        JsonArray list = new JsonArray();
        for (long position : positions) list.add(position);
        root.add("broken", list);
        return root.toString();
    }

    /** What {@link #toJson} wrote; anything unreadable is an empty list. */
    static BrokenDecor parse(String json) {
        BrokenDecor read = new BrokenDecor();
        try {
            JsonObject root = JsonParser.parseString(json).getAsJsonObject();
            read.season = root.has("season") ? root.get("season").getAsString() : "";
            read.since = root.has("since") ? root.get("since").getAsLong() : 0;
            if (root.has("broken")) {
                for (JsonElement position : root.getAsJsonArray("broken")) {
                    if (read.positions.size() >= MOST) break;
                    read.positions.add(position.getAsLong());
                }
            }
        } catch (RuntimeException unreadable) {
            return new BrokenDecor();
        }
        return read;
    }

    /** The list kept at {@code file}, or an empty one when there is none to read. */
    static BrokenDecor read(Path file) throws IOException {
        if (!Files.isRegularFile(file)) return new BrokenDecor();
        return parse(Files.readString(file, StandardCharsets.UTF_8));
    }

    /** Written to a temporary name and moved over, so a crash never leaves half a file. */
    void write(Path file) throws IOException {
        Path temporary = file.resolveSibling(file.getFileName() + ".tmp");
        Files.writeString(temporary, toJson(), StandardCharsets.UTF_8);
        Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }
}
