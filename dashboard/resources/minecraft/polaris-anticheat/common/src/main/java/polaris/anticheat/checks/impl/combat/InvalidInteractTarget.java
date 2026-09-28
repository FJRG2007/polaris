package polaris.anticheat.checks.impl.combat;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.player.PolarisPlayer;

@CheckData(name = "InvalidInteractTarget", stableKey = "polarisac.badpackets.invalid_entity_target", description = "Interacted with non-existent entity", experimental = true)
public class InvalidInteractTarget extends Check {
    public InvalidInteractTarget(PolarisPlayer player) {
        super(player);
    }
}
