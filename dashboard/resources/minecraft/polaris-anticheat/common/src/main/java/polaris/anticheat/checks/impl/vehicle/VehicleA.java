package polaris.anticheat.checks.impl.vehicle;

import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PreViaPacketReceiveListener;
import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientSteerVehicle;

@CheckData(name = "VehicleA", stableKey = "polarisac.vehicle.impossible_input", description = "Impossible input values")
public class VehicleA extends Check implements PreViaPacketReceiveListener {
    private static final Verbose V = Verbose.of("forwards={f32}, sideways={f32}");

    public VehicleA(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPreViaPacketReceive(final PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.STEER_VEHICLE) {
            final WrapperPlayClientSteerVehicle packet = new WrapperPlayClientSteerVehicle(event);

            if (Math.abs(packet.getForward()) > 0.98f || Math.abs(packet.getSideways()) > 0.98f) {
                if (flag(V.write(verbose()).f32(packet.getForward()).f32(packet.getSideways())) && shouldModifyPackets()) {
                    event.setCancelled(true);
                    player.onPacketCancel();
                }
            }
        }
    }
}
