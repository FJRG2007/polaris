package polaris.anticheat.checks.debug;

import polaris.anticheat.checks.PolarisProcessor;
import polaris.anticheat.player.PolarisPlayer;

public abstract class AbstractDebugHandler extends PolarisProcessor {
    public AbstractDebugHandler(PolarisPlayer player) {
        super(player);
    }

    public abstract void toggleListener(PolarisPlayer player);

    public abstract boolean toggleConsoleOutput();
}
