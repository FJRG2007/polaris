package polaris.anticheat.checks.type;

import polaris.anticheat.utils.anticheat.update.PositionUpdate;

public interface PositionListener {
    void onPositionUpdate(PositionUpdate positionUpdate);
}
