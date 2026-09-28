package polaris.anticheat.events.packets;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.manager.datastore.PlayerToggleStore;
import polaris.anticheat.platform.api.player.PlatformPlayer;
import polaris.anticheat.utils.anticheat.LogUtil;
import polaris.anticheat.utils.functions.ObjBooleanConsumer;
import com.github.retrooper.packetevents.event.*;
import com.github.retrooper.packetevents.netty.channel.ChannelHelper;
import com.github.retrooper.packetevents.protocol.ConnectionState;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import org.jetbrains.annotations.NotNull;

import java.util.Objects;
import java.util.UUID;

public class PacketPlayerJoinQuit extends PacketListenerAbstract {

    @Override
    public void onPacketSend(PacketSendEvent event) {
        if (event.getPacketType() == PacketType.Login.Server.LOGIN_SUCCESS) {
            // Do this after send to avoid sending packets before the PLAY state
            event.getTasksAfterSend().add(() -> {
                PolarisAPI.INSTANCE.getPlayerDataManager().addUser(event.getUser());
                // Prefetch the player's persisted alerts/verbose/brands toggles so onUserLogin can apply them immediately instead of falling back to the permission-default when the read hasn't completed in time.
                //
                // Runs on the backend's reader executor: never blocks this Netty thread. By the time onUserLogin fires (after chunk load / resource pack / motd) the prefetch has typically settled, and onUserLogin reads from the in-memory cache. A slow DB or a brand-new player with no row yet falls through to the permission-default.
                UUID uuid = event.getUser().getUUID();
                if (uuid != null) {
                    PolarisAPI.INSTANCE.getDataStoreLifecycle().playerToggleStore().prefetch(uuid);
                }
            });
        }
    }

    @Override
    public void onUserConnect(UserConnectEvent event) {
        // Player connected too soon, perhaps late bind is off
        // Don't kick everyone on reload
        if (event.getUser().getConnectionState() == ConnectionState.PLAY && !PolarisAPI.INSTANCE.getPlayerDataManager().isExemptUser(event.getUser())) {
            event.setCancelled(true);
        }
    }

    @Override
    public void onUserLogin(UserLoginEvent event) {
        // fake channel (NPC / spoofer / EmbeddedChannel) — no PacketUser, nothing to track
        if (event.getUser() == null) return;

        Object nativePlayerObject = Objects.requireNonNull(event.getPlayer(), "nativePlayerObject");

        // This will never throw a NPE because code is run in OnUserConnect -> onPacketSend -> OnUserLogin order
        // And the user will be added to the map before the getPlayer() method call
        @NotNull PlatformPlayer platformPlayer = PolarisAPI.INSTANCE.getPlatformPlayerFactory().getFromNativePlayerType(nativePlayerObject);

        if (PolarisAPI.INSTANCE.getConfigManager().getConfig().getBooleanElse("debug-pipeline-on-join", false)) {
            LogUtil.info("Pipeline: " + ChannelHelper.pipelineHandlerNamesAsString(event.getUser().getChannel()));
        }

        PlayerToggleStore toggles = PolarisAPI.INSTANCE.getDataStoreLifecycle().playerToggleStore();
        applyToggle(platformPlayer, toggles, PlayerToggleStore.KEY_ALERTS,
                "polarisac.alerts", "polarisac.alerts.enable-on-join", "polarisac.alerts.enable-on-join.silent",
                (p, silent) -> PolarisAPI.INSTANCE.getAlertManager().toggleAlerts(p, silent),
                (p, value) -> PolarisAPI.INSTANCE.getAlertManager().setAlertsEnabled(p, value, true));
        applyToggle(platformPlayer, toggles, PlayerToggleStore.KEY_VERBOSE,
                "polarisac.verbose", "polarisac.verbose.enable-on-join", "polarisac.verbose.enable-on-join.silent",
                (p, silent) -> PolarisAPI.INSTANCE.getAlertManager().toggleVerbose(p, silent),
                (p, value) -> PolarisAPI.INSTANCE.getAlertManager().setVerboseEnabled(p, value, true));
        applyToggle(platformPlayer, toggles, PlayerToggleStore.KEY_BRANDS,
                "polarisac.brand", "polarisac.brand.enable-on-join", "polarisac.brand.enable-on-join.silent",
                (p, silent) -> PolarisAPI.INSTANCE.getAlertManager().toggleBrands(p, silent),
                (p, value) -> PolarisAPI.INSTANCE.getAlertManager().setBrandsEnabled(p, value, true));

        if (platformPlayer.hasPermission("polarisac.spectate") && PolarisAPI.INSTANCE.getConfigManager().getConfig().getBooleanElse("spectators.hide-regardless", false)) {
            PolarisAPI.INSTANCE.getSpectateManager().onLogin(platformPlayer.getUniqueId());
        }

        PolarisAPI.INSTANCE.getDataStoreLifecycle().liveWriteHooks()
                .onJoinFromUserLogin(platformPlayer, event.getUser(), System.currentTimeMillis());
    }

    /**
     * Apply one of the three persistable toggles at login time, honouring the
     * source-of-truth precedence:
     * <pre>
     *   persisted state (from prefetch) > permission-default > unset.
     * </pre>
     * If the toggle store is unavailable (datastore disabled / failed init),
     * fall through to the legacy permission-only behaviour so the plugin
     * keeps working without the v1 datastore.
     *
     * @param permTogglePath  permission required to USE the toggle at all
     * @param permEnableOnJoin permission whose default is "on at login"
     * @param permSilentJoin  permission that suppresses the toggle message
     * @param toggle          legacy fallback path (with on/off flip behaviour)
     * @param applySilent     applies a known boolean value silently — used
     *                        when persisted state dictates a specific value
     */
    private static void applyToggle(@NotNull PlatformPlayer platformPlayer,
                                    @NotNull PlayerToggleStore toggles,
                                    @NotNull String key,
                                    @NotNull String permTogglePath,
                                    @NotNull String permEnableOnJoin,
                                    @NotNull String permSilentJoin,
                                    @NotNull ObjBooleanConsumer<PlatformPlayer> toggle,
                                    @NotNull ObjBooleanConsumer<PlatformPlayer> applySilent) {
        if (!platformPlayer.hasPermission(permTogglePath)) return;

        UUID uuid = platformPlayer.getUniqueId();
        Boolean persisted = toggles.current(uuid, key);

        if (persisted != null) {
            // Prefetch already settled — apply silently so reconnects don't
            // print the toggle message every time. enable-on-join.silent is
            // ignored on this path; persisted state already represents the
            // staff member's last explicit choice.
            applySilent.accept(platformPlayer, persisted);
            return;
        }

        // No persisted state visible yet (no row for this player, OR the
        // prefetch hasn't completed). Fall back to the permission-default
        // policy and persist the choice so it sticks. NOOP store treats both
        // applyPermissionDefault calls as silent no-ops.
        boolean enableOnJoin = platformPlayer.hasPermission(permEnableOnJoin);
        boolean silent = platformPlayer.hasPermission(permSilentJoin);
        if (enableOnJoin) {
            toggle.accept(platformPlayer, silent);
            toggles.applyPermissionDefault(uuid, key, true);
        } else {
            // Persist the negative decision too — without this, an admin who
            // grants enable-on-join later would silently flip the toggle on
            // for staff who'd already implicitly chosen "off" on prior joins.
            toggles.applyPermissionDefault(uuid, key, false);
        }
    }

    @Override
    public void onUserDisconnect(UserDisconnectEvent event) {
        // Session close + toggle eviction now live in PlayerDataManager.onDisconnect
        // so the ClientVersionSetter defensive path also closes sessions.
        PolarisAPI.INSTANCE.getPlayerDataManager().onDisconnect(event.getUser());
    }
}
