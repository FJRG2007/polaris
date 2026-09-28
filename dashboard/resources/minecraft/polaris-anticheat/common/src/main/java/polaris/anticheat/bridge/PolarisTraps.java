package polaris.anticheat.bridge;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where Polaris has buried its X-Ray honeypots on this server.
 *
 * The anti-xray hides every ore no player could see, and a honeypot is exactly
 * such an ore - so without this list it would hide the traps too, and nobody
 * using X-Ray would ever walk into one. With it, the traps are the only buried
 * ores an X-Ray client still shows.
 *
 * The reporter fetches the list from Polaris every minute; until the first answer
 * (or on a server Polaris does not run) there are no traps, which only means
 * every ore is hidden.
 */
public final class PolarisTraps {
    public static final int OVERWORLD = 0;
    public static final int NETHER = 1;

    /** A trap as Polaris sends it: [dimension, x, y, z]. */
    private static final Pattern TRAP = Pattern.compile("\\[\\s*([01])\\s*,\\s*(-?\\d{1,8})\\s*,\\s*(-?\\d{1,4})\\s*,\\s*(-?\\d{1,8})\\s*]");
    /** More than Polaris ever places; a longer list is not from Polaris. */
    static final int MAX_TRAPS = 4096;

    private static volatile LongOpenHashSet[] traps = {new LongOpenHashSet(), new LongOpenHashSet()};

    private PolarisTraps() {
    }

    public static boolean isTrap(int dimension, int x, int y, int z) {
        if (dimension < 0 || dimension > 1) return false;
        LongOpenHashSet set = traps[dimension];
        return !set.isEmpty() && set.contains(pack(x, y, z));
    }

    /** Replace the list with the one in a reply from Polaris. */
    static void accept(String body) {
        traps = parse(body);
    }

    static LongOpenHashSet[] parse(String body) {
        LongOpenHashSet[] next = {new LongOpenHashSet(), new LongOpenHashSet()};
        Matcher matcher = TRAP.matcher(body == null ? "" : body);
        int count = 0;
        while (matcher.find() && count++ < MAX_TRAPS) {
            next[Integer.parseInt(matcher.group(1))].add(pack(
                    Integer.parseInt(matcher.group(2)), Integer.parseInt(matcher.group(3)), Integer.parseInt(matcher.group(4))));
        }
        return next;
    }

    public static long pack(int x, int y, int z) {
        return ((long) (x & 0x3FFFFFF) << 38) | ((long) (z & 0x3FFFFFF) << 12) | (y & 0xFFF);
    }
}
