package polaris.anticheat.checks.impl.sprint;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PacketReceiveListener;
import polaris.anticheat.checks.type.PostPredictionListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.PredictionComplete;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientEntityAction;

@CheckData(name = "SprintE", stableKey = "polarisac.sprint.wall", description = "Sprinting while colliding with a wall", setback = 5, experimental = true)
public class SprintE extends Check implements PacketReceiveListener, PostPredictionListener {
    private boolean startedSprintingThisTick, wasHardHorizontalCollision;

    public SprintE(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPacketReceive(PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.ENTITY_ACTION) {
            if (new WrapperPlayClientEntityAction(event).getAction() == WrapperPlayClientEntityAction.Action.START_SPRINTING) {
                startedSprintingThisTick = true;
            }
        }
    }

    @Override
    public void onPredictionComplete(final PredictionComplete predictionComplete) {
        if (!predictionComplete.isChecked()) return;

        if (wasHardHorizontalCollision && !startedSprintingThisTick && !player.uncertaintyHandler.isNearGlitchyBlock
                && !player.inVehicle() && !player.uncertaintyHandler.lastVehicleSwitch.hasOccurredSince(0)
                && (!player.wasTouchingWater || player.getClientVersion().isOlderThan(ClientVersion.V_1_13))
                && player.wasLastPredictionCompleteChecked) {
            if (player.isSprinting) {
                flagWithSetback();
            } else {
                reward();
            }
        }

        wasHardHorizontalCollision = player.horizontalCollision && !player.softHorizontalCollision && player.wasLastPredictionCompleteChecked;
        startedSprintingThisTick = false;
    }
}
