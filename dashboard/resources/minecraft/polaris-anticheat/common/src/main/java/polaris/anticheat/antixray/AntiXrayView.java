package polaris.anticheat.antixray;

import it.unimi.dsi.fastutil.ints.Int2IntMap;
import it.unimi.dsi.fastutil.ints.Int2IntOpenHashMap;
import it.unimi.dsi.fastutil.ints.IntOpenHashSet;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;

import java.util.function.IntConsumer;

/**
 * What one player's client was told about the ores near them: which positions it
 * was sent as rock, with the block really there, and which it has since been shown.
 *
 * Only ever touched from the player's connection thread - chunks and block
 * updates are written there, and digging is read there - so nothing here locks.
 */
public final class AntiXrayView {
    /** Chunk -> (position in the chunk -> the block really there), for positions sent as rock. */
    private final Long2ObjectOpenHashMap<Int2IntOpenHashMap> hidden = new Long2ObjectOpenHashMap<>();
    /** Chunk -> positions shown for what they are since the chunk was sent. */
    private final Long2ObjectOpenHashMap<IntOpenHashSet> revealed = new Long2ObjectOpenHashMap<>();
    /** The lowest block of the dimension the positions are counted from. */
    private int minY;

    public static long chunkKey(int chunkX, int chunkZ) {
        return ((long) chunkX & 0xFFFFFFFFL) | (((long) chunkZ & 0xFFFFFFFFL) << 32);
    }

    int index(int x, int y, int z) {
        return ((y - minY) << 8) | ((z & 15) << 4) | (x & 15);
    }

    int yOf(int index) {
        return (index >>> 8) + minY;
    }

    /** A new dimension or a new login: nothing sent before still stands. */
    public void reset(int minY) {
        hidden.clear();
        revealed.clear();
        this.minY = minY;
    }

    int minY() {
        return minY;
    }

    /** The chunk is sent again from scratch. */
    Int2IntOpenHashMap startChunk(long key) {
        revealed.remove(key);
        Int2IntOpenHashMap map = new Int2IntOpenHashMap();
        map.defaultReturnValue(-1);
        hidden.put(key, map);
        return map;
    }

    /** Some sections of the chunk are sent again; the rest of it stands. */
    Int2IntOpenHashMap startSections(long key, boolean[] resent) {
        Int2IntOpenHashMap map = hidden.get(key);
        if (map == null) return startChunk(key);
        map.int2IntEntrySet().removeIf(entry -> sectionIn(resent, entry.getIntKey()));
        IntOpenHashSet shown = revealed.get(key);
        if (shown != null) shown.removeIf(index -> sectionIn(resent, index));
        return map;
    }

    private static boolean sectionIn(boolean[] sections, int index) {
        int section = index >>> 12;
        return section < sections.length && sections[section];
    }

    public void unload(int chunkX, int chunkZ) {
        long key = chunkKey(chunkX, chunkZ);
        hidden.remove(key);
        revealed.remove(key);
    }

    Int2IntOpenHashMap chunk(int chunkX, int chunkZ) {
        return hidden.get(chunkKey(chunkX, chunkZ));
    }

    boolean isTracked(int chunkX, int chunkZ) {
        return hidden.containsKey(chunkKey(chunkX, chunkZ));
    }

    /** Whether the client holds this position as rock while something else is there. */
    public boolean isHidden(int x, int y, int z) {
        Int2IntOpenHashMap map = hidden.get(chunkKey(x >> 4, z >> 4));
        return map != null && map.containsKey(index(x, y, z));
    }

    boolean isRevealed(int x, int y, int z) {
        IntOpenHashSet shown = revealed.get(chunkKey(x >> 4, z >> 4));
        return shown != null && shown.contains(index(x, y, z));
    }

    /** The block really at a hidden position, or -1. */
    int realAt(int x, int y, int z) {
        Int2IntOpenHashMap map = hidden.get(chunkKey(x >> 4, z >> 4));
        return map == null ? -1 : map.get(index(x, y, z));
    }

    void hide(int x, int y, int z, int real) {
        Int2IntOpenHashMap map = hidden.get(chunkKey(x >> 4, z >> 4));
        if (map != null) map.put(index(x, y, z), real);
    }

    void forget(int x, int y, int z) {
        Int2IntOpenHashMap map = hidden.get(chunkKey(x >> 4, z >> 4));
        if (map != null) map.remove(index(x, y, z));
    }

    /**
     * Stop hiding a position: returns the block really there, to send, or -1 when
     * it was not hidden.
     */
    int reveal(int x, int y, int z) {
        long key = chunkKey(x >> 4, z >> 4);
        Int2IntOpenHashMap map = hidden.get(key);
        if (map == null) return -1;
        int index = index(x, y, z);
        int real = map.remove(index);
        if (real < 0) return -1;
        revealed.computeIfAbsent(key, ignored -> new IntOpenHashSet()).add(index);
        return real;
    }

    /** Every hidden position of a chunk, as positions in the chunk. */
    void forEachHidden(int chunkX, int chunkZ, IntConsumer action) {
        Int2IntOpenHashMap map = hidden.get(chunkKey(chunkX, chunkZ));
        if (map == null) return;
        int[] indexes = map.keySet().toIntArray();
        for (int index : indexes) action.accept(index);
    }

    int hiddenCount() {
        int total = 0;
        for (Int2IntMap map : hidden.values()) total += map.size();
        return total;
    }
}
