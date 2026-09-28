package polaris.anticheat.manager.init.stop;

import polaris.anticheat.manager.init.Initable;

public interface StoppableInitable extends Initable {
    void stop();
}
