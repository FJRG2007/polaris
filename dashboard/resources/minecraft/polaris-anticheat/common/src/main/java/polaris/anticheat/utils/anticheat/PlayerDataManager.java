package polaris.anticheat.utils.anticheat;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.api.event.events.PolarisJoinEvent;
import polaris.anticheat.api.event.events.PolarisQuitEvent;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.platform.api.player.PlatformPlayer;
import polaris.anticheat.platform.api.player.PlatformPlayerCache;
import polaris.anticheat.utils.reflection.GeyserUtil;
import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.netty.channel.ChannelHelper;
import com.github.retrooper.packetevents.protocol.player.User;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.Collection;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class PlayerDataManager {

    // Holder — PlayerDataManager is constructed inside PolarisAPI's ctor, so a
    // plain static-final would see a null PolarisAPI.INSTANCE. Holder init runs
    // on first fire, after PolarisAPI is fully built.
    private static final class Channels {
        static final PolarisJoinEvent.Channel JOIN = PolarisAPI.INSTANCE.getEventBus().get(PolarisJoinEvent.class);
        static final PolarisQuitEvent.Channel QUIT = PolarisAPI.INSTANCE.getEventBus().get(PolarisQuitEvent.class);
    }

    private final Set<User> exemptUsers = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<User, PolarisPlayer> playerDataMap = new ConcurrentHashMap<>();

    public boolean isExemptUser(@Nullable User user) {
        return user != null && exemptUsers.contains(user);
    }

    public void exemptUser(@Nullable User user) {
        if (user == null) return;
        exemptUsers.add(user);
    }

    public boolean clearExemptions(@Nullable User user) {
        if (user == null) return false;
        return exemptUsers.remove(user);
    }

    @Nullable
    public PolarisPlayer getPlayer(final @NotNull UUID uuid) {
        // Is it safe to interact with this, or is this internal PacketEvents code?
        Object channel = PacketEvents.getAPI().getProtocolManager().getChannel(uuid);
        if (channel == null) return null;
        User user = PacketEvents.getAPI().getProtocolManager().getUser(channel);
        if (user == null) return null;
        return getPlayer(user);
    }

    @Nullable
    public PolarisPlayer getPlayer(final @NotNull User user) {
        @Nullable PolarisPlayer player = playerDataMap.get(user);
        if (player != null && player.platformPlayer != null && player.platformPlayer.isExternalPlayer())
            return null;
        return player;
    }

    public boolean shouldCheck(@NotNull User user) {
        if (isExemptUser(user)) return false;
        if (!ChannelHelper.isOpen(user.getChannel())) return false;

        if (user.getUUID() != null) {
            // Bedrock players don't have Java movement
            if (GeyserUtil.isBedrockPlayer(user.getUUID())) {
                exemptUser(user);
                return false;
            }

            // Has exempt permission
            PolarisPlayer polarisacPlayer = PolarisAPI.INSTANCE.getPlayerDataManager().getPlayer(user);
            if (polarisacPlayer != null && polarisacPlayer.hasPermission("polarisac.exempt")) {
                exemptUser(user);
                return false;
            }

            // Geyser formatted player string
            // This will never happen for Java players, as the first character in the 3rd group is always 4 (xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx)
            if (user.getUUID().toString().startsWith("00000000-0000-0000-0009")) {
                exemptUser(user);
                return false;
            }
        }

        return true;
    }

    public void addUser(final @NotNull User user) {
        if (shouldCheck(user)) {
            PolarisPlayer player = new PolarisPlayer(user);
            playerDataMap.put(user, player);
            Channels.JOIN.fire(player);
        }
    }

    public PolarisPlayer remove(final @NotNull User user) {
        return playerDataMap.remove(user);
    }

    public void onDisconnect(User user) {
        PolarisPlayer polarisacPlayer = remove(user);
        if (polarisacPlayer != null) Channels.QUIT.fire(polarisacPlayer);
        clearExemptions(user);

        UUID uuid = user.getProfile().getUUID();

        // All cleanup paths should call onDisconnect; routing the session-close + toggle
        // eviction here means a stuck PE event (or a JVM-level channel
        // close that doesn't surface as UserDisconnectEvent) doesn't leak an open session.
        // hooks/toggles are NOOP when the datastore is disabled or its init failed
        // AND go NOOP mid-session if an operator runs /polarisac reload after flipping database.enabled to false
        // a player who joined under the prior (enabled) config and disconnects post-reload has no live writer to fire onQuit, so their session stays open (row closed_at IS NULL).
        // The next datastore-enabled boot's crash sweep stamps closed_at = last_activity for still-open rows; permanently-disabled-after-the-fact leaves the row untouched until DB is enabled again.
        PolarisAPI.INSTANCE.getDataStoreLifecycle().liveWriteHooks()
                .onQuitFromUserDisconnect(user, polarisacPlayer, System.currentTimeMillis());
        if (uuid != null) {
            PolarisAPI.INSTANCE.getDataStoreLifecycle().playerToggleStore().evict(uuid);
        }

        // Check if calling async is safe
        if (uuid == null)
            return; // folia doesn't like null getPlayer()

        PlatformPlayer quittingPlayer = PlatformPlayerCache.getInstance().getPlayer(uuid);
        if (quittingPlayer != null) {
            PolarisAPI.INSTANCE.getAlertManager().handlePlayerQuit(quittingPlayer);
        }

        PolarisAPI.INSTANCE.getSpectateManager().onQuit(uuid);

        // TODO (Cross-platform) confirm this is 100% correct and will always remove players from cache when necessary
        PolarisAPI.INSTANCE.getPlatformPlayerFactory().invalidatePlayer(uuid);
    }

    public Collection<PolarisPlayer> getEntries() {
        return playerDataMap.values();
    }

    public int size() {
        return playerDataMap.size();
    }
}
