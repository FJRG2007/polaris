package polaris.anticheat.checks.impl.timer;

import polaris.anticheat.api.config.ConfigManager;
import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PacketReceiveListener;
import polaris.anticheat.checks.type.PostPredictionListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.PredictionComplete;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import org.jetbrains.annotations.NotNull;

@CheckData(name = "NegativeTimer", stableKey = "polarisac.timer.negative", description = "Sent movement packets slower than the expected client tick rate", setback = -1, experimental = true)
public class NegativeTimer extends Timer implements PacketReceiveListener, PostPredictionListener {
    private static final Verbose V = Verbose.of("-{ulong}ms");

    public NegativeTimer(PolarisPlayer player) {
        super(player);
        timerBalanceRealTime = System.nanoTime() + clockDrift;
    }

    @Override
    public void onPrePredictionPacketReceive(PacketReceiveEvent event) {
        // NegativeTimer runs the inherited timer processing during normal packet dispatch.
    }

    @Override
    public void onPacketReceive(PacketReceiveEvent event) {
        super.onPrePredictionPacketReceive(event);
    }

    @Override
    public void onPredictionComplete(final PredictionComplete predictionComplete) {
        // We can't negative timer check a 1.9+ player who is standing still.
        if (player.uncertaintyHandler.lastPointThree.hasOccurredSince(2) || !predictionComplete.isChecked()) {
            timerBalanceRealTime = System.nanoTime() + clockDrift;
        }

        if (timerBalanceRealTime < lastMovementPlayerClock - clockDrift) {
            int lostMS = (int) ((System.nanoTime() - timerBalanceRealTime) / 1e6);
            flagWithSetback(V.write(verbose()).ulong(lostMS));
            timerBalanceRealTime += 50e6;
        }
    }

    @Override
    public void doCheck(final PacketReceiveEvent event) {
        // We don't know if the player is ticking stable, therefore we must wait until prediction
        // determines this.  Do nothing here!
    }

    @Override
    public void onReload(@NotNull ConfigManager config) {
        clockDrift = (long) (config.getDoubleElse(getConfigName() + ".drift", 1200.0) * 1e6);
    }
}
