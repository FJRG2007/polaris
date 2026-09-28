package polaris.anticheat.checks.type;

import polaris.anticheat.utils.anticheat.update.PredictionComplete;

public interface PostPredictionListener {
    void onPredictionComplete(PredictionComplete predictionComplete);
}
