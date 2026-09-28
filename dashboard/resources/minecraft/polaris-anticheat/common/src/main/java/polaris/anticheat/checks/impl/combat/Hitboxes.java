package polaris.anticheat.checks.impl.combat;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.player.PolarisPlayer;

@CheckData(name = "Hitboxes", stableKey = "polarisac.combat.hitboxes", description = "Tried to hit an entity outside its valid hitbox")
public class Hitboxes extends Check {
    public Hitboxes(PolarisPlayer player) {
        super(player);
    }
}
