package polaris.anticheat.checks.impl.crash;

import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PrePredictionPacketReceiveListener;
import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.world.Location;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientPlayerFlying;

@CheckData(name = "CrashC", stableKey = "polarisac.crash.nan_position", description = "Sent non-finite position or rotation")
public class CrashC extends Check implements PrePredictionPacketReceiveListener {
    private static final Verbose V =
            Verbose.of("xyzYP={f64}, {f64}, {f64}, {f32}, {f32}");

    public CrashC(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPrePredictionPacketReceive(PacketReceiveEvent event) {
        if (WrapperPlayClientPlayerFlying.isFlying(event.getPacketType())) {
            WrapperPlayClientPlayerFlying flying = new WrapperPlayClientPlayerFlying(event);
            if (flying.hasPositionChanged()) {
                Location pos = flying.getLocation();
                if (!Double.isFinite(pos.getX()) || !Double.isFinite(pos.getY()) || !Double.isFinite(pos.getZ())
                    || !Float.isFinite(pos.getYaw()) || !Float.isFinite(pos.getPitch())) {
                    flag(V.write(verbose()).f64(pos.getX()).f64(pos.getY()).f64(pos.getZ()).f32(pos.getYaw()).f32(pos.getPitch()));
                    executeViolationSetback();
                    event.setCancelled(true);
                    player.onPacketCancel();
                }
            }
        }
    }
}
