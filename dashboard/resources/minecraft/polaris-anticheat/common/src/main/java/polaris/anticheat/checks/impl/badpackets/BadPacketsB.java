package polaris.anticheat.checks.impl.badpackets;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.player.PolarisPlayer;

@CheckData(name = "BadPacketsB", stableKey = "polarisac.badpackets.ignored_rotation", description = "Ignored set rotation packet")
public class BadPacketsB extends Check {
    public BadPacketsB(final PolarisPlayer player) {
        super(player);
    }
}
