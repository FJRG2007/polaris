package polaris.anticheat.manager;

import polaris.anticheat.checks.PolarisProcessor;
import polaris.anticheat.checks.type.PostPredictionListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.PredictionComplete;
import polaris.anticheat.utils.data.LastInstance;

import java.util.ArrayList;
import java.util.List;

public class LastInstanceManager extends PolarisProcessor implements PostPredictionListener {
    private final List<LastInstance> instances = new ArrayList<>();

    public LastInstanceManager(PolarisPlayer player) {
        super(player);
    }

    public void addInstance(LastInstance instance) {
        instances.add(instance);
    }

    @Override
    public void onPredictionComplete(final PredictionComplete predictionComplete) {
        for (LastInstance instance : instances) {
            instance.tick();
        }
    }
}
