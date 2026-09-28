package polaris.anticheat.checks.impl.aim;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.RotationListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.RotationUpdate;

@CheckData(name = "AimDuplicateLook", stableKey = "polarisac.aim.duplicate_look", description = "Sent a duplicate rotation update without changing look direction")
public class AimDuplicateLook extends Check implements RotationListener {
    private boolean exempt;

    public AimDuplicateLook(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void process(final RotationUpdate rotationUpdate) {
        if (player.packetStateData.lastPacketWasTeleport || player.packetStateData.lastPacketWasOnePointSeventeenDuplicate || player.compensatedEntities.self.getRiding() != null) {
            exempt = true;
            return;
        }

        if (exempt) { // Exempt for a tick on teleport
            exempt = false;
            return;
        }

        if (rotationUpdate.oldYaw() == rotationUpdate.newYaw() && rotationUpdate.oldPitch() == rotationUpdate.newPitch()) {
            flag();
        }
    }
}
