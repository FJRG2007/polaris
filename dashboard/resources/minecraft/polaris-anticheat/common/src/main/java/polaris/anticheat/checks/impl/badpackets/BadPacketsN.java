package polaris.anticheat.checks.impl.badpackets;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.player.PolarisPlayer;

@CheckData(name = "BadPacketsN", stableKey = "polarisac.badpackets.invalid_teleport", description = "Ignored or failed to accept a required server teleport")
public class BadPacketsN extends Check {
    public BadPacketsN(final PolarisPlayer player) {
        super(player);
    }
}
