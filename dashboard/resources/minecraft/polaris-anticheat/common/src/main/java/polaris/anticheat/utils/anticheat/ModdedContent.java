package polaris.anticheat.utils.anticheat;

import com.github.retrooper.packetevents.protocol.item.ItemStack;
import com.github.retrooper.packetevents.protocol.item.type.ItemType;
import org.jetbrains.annotations.NotNull;
import polaris.anticheat.player.PolarisPlayer;

import java.util.BitSet;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

/**
 * Content a modded server has that the engine only knows through a stand-in.
 *
 * A modded platform fills this once at start: every block state a mod adds is
 * "modded", and the ones whose collision or behaviour has no vanilla equal are also
 * "unmodelled". The simulation does not guess at an unmodelled block: a player
 * touching one is not predicted for that tick. On Bukkit nothing is installed and
 * every question here is answered from an empty set.
 */
public final class ModdedContent {

    private static final double MAX_SWEPT_MOVE = 4.0;

    private static volatile BitSet moddedBlocks = new BitSet();
    private static volatile BitSet unmodelledBlocks = new BitSet();
    private static volatile Set<ItemType> moddedItems = Collections.emptySet();

    private ModdedContent() {
    }

    public static void install(@NotNull BitSet modded, @NotNull BitSet unmodelled, @NotNull Set<ItemType> items) {
        Set<ItemType> copy = Collections.newSetFromMap(new IdentityHashMap<>());
        copy.addAll(items);
        moddedBlocks = (BitSet) modded.clone();
        unmodelledBlocks = (BitSet) unmodelled.clone();
        moddedItems = Collections.unmodifiableSet(copy);
    }

    public static boolean isModdedBlock(int globalId) {
        return globalId > 0 && moddedBlocks.get(globalId);
    }

    public static boolean isUnmodelledBlock(int globalId) {
        return globalId > 0 && unmodelledBlocks.get(globalId);
    }

    public static boolean isModdedItem(ItemStack stack) {
        return stack != null && !moddedItems.isEmpty() && moddedItems.contains(stack.getType());
    }

    /**
     * Whether an unmodelled block is within a block of where the player was or is
     * this tick: the simulation cannot say how it pushes, slows or carries them.
     */
    public static boolean touchesUnmodelled(@NotNull PolarisPlayer player) {
        BitSet unmodelled = unmodelledBlocks;
        if (unmodelled.isEmpty()) return false;

        if (Math.abs(player.x - player.lastX) <= MAX_SWEPT_MOVE
                && Math.abs(player.y - player.lastY) <= MAX_SWEPT_MOVE
                && Math.abs(player.z - player.lastZ) <= MAX_SWEPT_MOVE) {
            return scan(player, unmodelled, player.lastX, player.lastY, player.lastZ, player.x, player.y, player.z);
        }
        return scan(player, unmodelled, player.lastX, player.lastY, player.lastZ, player.lastX, player.lastY, player.lastZ)
                || scan(player, unmodelled, player.x, player.y, player.z, player.x, player.y, player.z);
    }

    private static boolean scan(PolarisPlayer player, BitSet unmodelled, double fromX, double fromY, double fromZ, double toX, double toY, double toZ) {
        double halfWidth = player.pose.width / 2.0 + 1.0;
        int minX = (int) Math.floor(Math.min(fromX, toX) - halfWidth);
        int maxX = (int) Math.floor(Math.max(fromX, toX) + halfWidth);
        int minZ = (int) Math.floor(Math.min(fromZ, toZ) - halfWidth);
        int maxZ = (int) Math.floor(Math.max(fromZ, toZ) + halfWidth);
        int minY = (int) Math.floor(Math.min(fromY, toY) - 1.0);
        int maxY = (int) Math.floor(Math.max(fromY, toY) + player.pose.height + 0.5);

        for (int x = minX; x <= maxX; x++) {
            for (int z = minZ; z <= maxZ; z++) {
                for (int y = minY; y <= maxY; y++) {
                    int id = player.compensatedWorld.getBlockStateId(x, y, z);
                    if (id > 0 && unmodelled.get(id)) return true;
                }
            }
        }
        return false;
    }
}
