package polaris.anticheat.checks.impl.crash;

import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PacketReceiveListener;
import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientSettings;

@CheckData(name = "CrashE", stableKey = "polarisac.crash.low_view_distance", description = "Sent a client view distance below the minimum allowed value")
public class CrashE extends Check implements PacketReceiveListener {
    private static final Verbose V = Verbose.of("distance={sint}");

    public CrashE(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPacketReceive(final PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.CLIENT_SETTINGS) {
            WrapperPlayClientSettings wrapper = new WrapperPlayClientSettings(event);
            int viewDistance = wrapper.getViewDistance();
            if (viewDistance < 2) {
                flag(V.write(verbose()).sint(viewDistance));
                wrapper.setViewDistance(2);
            }
        }
    }

}
