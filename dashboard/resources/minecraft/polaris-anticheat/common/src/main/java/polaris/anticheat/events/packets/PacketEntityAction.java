package polaris.anticheat.events.packets;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.checks.impl.elytra.ElytraA;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.data.IntToObjectPair;
import polaris.anticheat.utils.data.SprintingState;
import polaris.anticheat.utils.data.packetentity.JumpableEntity;
import polaris.anticheat.utils.data.packetentity.PacketEntity;
import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.event.PacketListenerAbstract;
import com.github.retrooper.packetevents.event.PacketListenerPriority;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.manager.server.ServerVersion;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientEntityAction;

public class PacketEntityAction extends PacketListenerAbstract {

    public PacketEntityAction() {
        super(PacketListenerPriority.LOW);
    }

    @Override
    public void onPacketReceive(PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.ENTITY_ACTION) {
            WrapperPlayClientEntityAction action = new WrapperPlayClientEntityAction(event);
            PolarisPlayer player = PolarisAPI.INSTANCE.getPlayerDataManager().getPlayer(event.getUser());

            if (player == null) return;

            switch (action.getAction()) {
                case START_SPRINTING -> {
                    player.isSprinting = true;
                    player.vehicleData.camelSprintingState = SprintingState.STARTED;
                }
                case STOP_SPRINTING -> {
                    player.isSprinting = false;
                    player.vehicleData.camelSprintingState = SprintingState.STOPPED;
                }
                case START_SNEAKING -> player.isSneaking = true;
                case STOP_SNEAKING -> player.isSneaking = false;
                case START_FLYING_WITH_ELYTRA -> {
                    if (PacketEvents.getAPI().getServerManager().getVersion().isOlderThan(ServerVersion.V_1_9))
                        return;

                    if (player.onGround || player.lastOnGround) {
                        player.getSetbackTeleportUtil().executeNonSimulatingForceResync();
                        player.resyncGlidingState();
                        event.setCancelled(true);
                        player.onPacketCancel();
                        return;
                    }

                    player.checkManager.get(ElytraA.class).onStartGliding(event);

                    // Starting fall flying is server sided on 1.14 and below
                    if (player.getClientVersion().isOlderThan(ClientVersion.V_1_15)) return;

                    // This shouldn't be needed with latency compensated inventories
                    // TODO: Remove this?
                    if (player.canGlide()) {
                        player.isGliding = true;
                        player.pointThreeEstimator.updatePlayerGliding();
                    } else {
                        // A client is flying with a ghost elytra, resync
                        player.getSetbackTeleportUtil().executeNonSimulatingForceResync();
                        player.resyncGlidingState();
                        event.setCancelled(true);
                        player.onPacketCancel();
                    }
                }
                case START_JUMPING_WITH_HORSE -> {
                    PacketEntity riding = player.compensatedEntities.self.getRiding();
                    if (riding instanceof JumpableEntity jumpable) {
                        if (player.vehicleData.pendingJumps.size() >= 20) return; // discard
                        player.vehicleData.pendingJumps.add(new IntToObjectPair<>(action.getJumpBoost(), jumpable));
                    }
                }
            }
        }
    }
}
