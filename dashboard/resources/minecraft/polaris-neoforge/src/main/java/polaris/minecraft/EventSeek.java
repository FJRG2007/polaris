package polaris.minecraft;

import it.unimi.dsi.fastutil.ints.Int2ObjectMap;
import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongIterator;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.scores.PlayerTeam;
import polaris.minecraft.mixin.ChunkMapAccessor;

/**
 * Hide and seek, kept honest by the server: a hider is not sent to a seeker who
 * cannot see them.
 *
 * While an event tags players {@link #HIDER} and {@link #SEEKER} - or puts them
 * in the hide and seek teams {@link #HIDER_TEAM} and {@link #SEEKER_TEAM} - a hider's
 * entity is not tracked by a seeker farther than {@link #NEAR} blocks without a
 * clear line from the seeker's eyes to the hider (a ray through blocks' visual
 * shapes, so glass hides nothing). The client never learns where the hider is,
 * which leaves a minimap radar or an ESP nothing to draw.
 *
 * Bounded: the pairs are checked round-robin, at most {@link #RAYS_PER_TICK} a
 * tick, every pair at least every {@link #PERIOD} ticks while that fits. A pair
 * not yet checked counts as not seen, so a hider never flashes into view. With no
 * tagged players nothing runs but one look at the player list every
 * {@link #IDLE_PERIOD} ticks.
 *
 * Server thread only, including {@link #conceals}, which the tracker mixin asks.
 */
public final class EventSeek {
    static final String HIDER = "pe_hider";
    static final String SEEKER = "pe_seeker";
    /** The teams the dashboard's hide and seek puts each side in (`TEAMS` in
     *  `hide-and-seek.ts`): either marks a side, as the tags do. */
    static final String HIDER_TEAM = "pe_hs_hide";
    static final String SEEKER_TEAM = "pe_hs_seek";
    private static final double NEAR = 2.0;
    /** Farther than this nobody is drawn anyway. */
    private static final double FAR = 160.0;
    private static final int PERIOD = 4;
    private static final int IDLE_PERIOD = 10;
    private static final int RAYS_PER_TICK = 192;

    private static boolean active;
    private static int tick;
    private static int cursor;
    /** Pairs (seeker, hider) seen at the last check. */
    private static final LongOpenHashSet visible = new LongOpenHashSet();
    /** Pairs held back from the seeker's tracker: shown again when that ends. */
    private static final LongOpenHashSet concealed = new LongOpenHashSet();

    private EventSeek() {}

    /**
     * Whether the tracker hooks are in this game: another mod that replaced the
     * entity tracker leaves them out, and then hide and seek is not offered
     * (`polaris caps` leaves it off) rather than half working.
     */
    static boolean available() {
        try {
            Class<?> tracked = Class.forName("net.minecraft.server.level.ChunkMap$TrackedEntity");
            return ChunkMapAccessor.class.isAssignableFrom(ChunkMap.class)
                    && SeekTracker.class.isAssignableFrom(tracked);
        } catch (ClassNotFoundException | LinkageError missing) {
            return false;
        }
    }

    /** Something failed: everybody held back is shown again, and it stays off. */
    static void giveUp(MinecraftServer server) {
        Int2ObjectMap<ServerPlayer> byId = new Int2ObjectOpenHashMap<>();
        for (ServerPlayer player : server.getPlayerList().getPlayers()) byId.put(player.getId(), player);
        stop(byId);
    }

    private static long pair(int seeker, int hider) {
        return ((long) seeker << 32) | (hider & 0xffffffffL);
    }

    /** Whether the tracker must keep {@code entity} from {@code viewer} now. */
    public static boolean conceals(Entity entity, ServerPlayer viewer) {
        if (!active || !(entity instanceof ServerPlayer hider) || hider == viewer) return false;
        if (!marked(hider, HIDER, HIDER_TEAM) || !marked(viewer, SEEKER, SEEKER_TEAM)) return false;
        if (hider.isSpectator() || hider.level() != viewer.level()) return false;
        if (hider.distanceToSqr(viewer) <= NEAR * NEAR) return false;
        return !visible.contains(pair(viewer.getId(), hider.getId()));
    }

    private static boolean marked(ServerPlayer player, String tag, String team) {
        if (player.getTags().contains(tag)) return true;
        PlayerTeam joined = player.getTeam();
        return joined != null && joined.getName().equals(team);
    }

    /** The tracker held a hider back from a seeker. */
    public static void heldBack(Entity hider, ServerPlayer seeker) {
        concealed.add(pair(seeker.getId(), hider.getId()));
    }

    static void tick(MinecraftServer server) {
        tick++;
        if (!active && tick % IDLE_PERIOD != 0) return;
        List<ServerPlayer> hiders = new ArrayList<>();
        List<ServerPlayer> seekers = new ArrayList<>();
        Int2ObjectMap<ServerPlayer> byId = new Int2ObjectOpenHashMap<>();
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (marked(player, HIDER, HIDER_TEAM)) hiders.add(player);
            if (marked(player, SEEKER, SEEKER_TEAM)) seekers.add(player);
            byId.put(player.getId(), player);
        }
        if (hiders.isEmpty() || seekers.isEmpty()) {
            if (active) stop(byId);
            return;
        }
        if (!active) {
            active = true;
            cursor = 0;
            // Everybody already tracked is asked again: the hiders go.
            for (ServerPlayer seeker : seekers) for (ServerPlayer hider : hiders) refresh(hider, seeker);
        }
        // Held back, and no longer to be: tags changed, came near, left.
        LongIterator each = concealed.iterator();
        while (each.hasNext()) {
            long key = each.nextLong();
            ServerPlayer seeker = byId.get((int) (key >> 32));
            ServerPlayer hider = byId.get((int) key);
            if (seeker == null || hider == null) {
                each.remove();
                visible.remove(key);
            } else if (!conceals(hider, seeker)) {
                each.remove();
                refresh(hider, seeker);
            }
        }
        long total = (long) seekers.size() * hiders.size();
        if (total <= RAYS_PER_TICK && tick % PERIOD != 0) return;
        long budget = Math.min(total, RAYS_PER_TICK);
        for (long done = 0; done < budget; done++) {
            int index = (int) (cursor % total);
            cursor = (int) ((cursor + 1) % total);
            ServerPlayer seeker = seekers.get(index / hiders.size());
            ServerPlayer hider = hiders.get(index % hiders.size());
            if (seeker == hider) continue;
            long key = pair(seeker.getId(), hider.getId());
            boolean sees = sees(seeker, hider);
            if (sees == visible.contains(key)) continue;
            if (sees) visible.add(key);
            else visible.remove(key);
            refresh(hider, seeker);
        }
    }

    /** No more tags: everybody held back is sent again. */
    private static void stop(Int2ObjectMap<ServerPlayer> byId) {
        active = false;
        LongIterator each = concealed.iterator();
        while (each.hasNext()) {
            long key = each.nextLong();
            ServerPlayer seeker = byId.get((int) (key >> 32));
            ServerPlayer hider = byId.get((int) key);
            if (seeker != null && hider != null) refresh(hider, seeker);
        }
        concealed.clear();
        visible.clear();
    }

    private static boolean sees(ServerPlayer seeker, ServerPlayer hider) {
        if (seeker.level() != hider.level()) return false;
        double distance = seeker.distanceToSqr(hider);
        if (distance <= NEAR * NEAR) return true;
        if (distance > FAR * FAR) return false;
        Vec3 eyes = seeker.getEyePosition();
        double x = hider.getX();
        double z = hider.getZ();
        double y = hider.getY();
        double height = hider.getBbHeight();
        return clear(seeker, eyes, hider.getEyePosition())
                || clear(seeker, eyes, new Vec3(x, y + height * 0.5, z))
                || clear(seeker, eyes, new Vec3(x, y + 0.1, z));
    }

    private static boolean clear(ServerPlayer seeker, Vec3 from, Vec3 to) {
        ClipContext ray = new ClipContext(from, to, ClipContext.Block.VISUAL, ClipContext.Fluid.NONE, seeker);
        return seeker.level().clip(ray).getType() == HitResult.Type.MISS;
    }

    /** The hider's tracker asked again about this seeker: shown or held back as {@link #conceals} says. */
    private static void refresh(ServerPlayer hider, ServerPlayer seeker) {
        if (hider == seeker || !(hider.level() instanceof ServerLevel level)) return;
        ChunkMap map = level.getChunkSource().chunkMap;
        if (!((Object) map instanceof ChunkMapAccessor trackers)) return;
        Object tracked = trackers.polaris$entityMap().get(hider.getId());
        if (tracked instanceof SeekTracker tracker) tracker.polaris$refresh(seeker);
    }

    /** What the tracker mixin adds to the game's entity tracker. */
    public interface SeekTracker {
        void polaris$refresh(ServerPlayer viewer);
    }
}
