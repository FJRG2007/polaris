package polaris.anticheat.checks.impl.vehicle;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PreViaPacketReceiveListener;
import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;

@CheckData(name = "VehicleB", stableKey = "polarisac.vehicle.spoofed_vehicle", description = "Claimed to be in a vehicle while not in a vehicle")
public class VehicleB extends Check implements PreViaPacketReceiveListener {
    public VehicleB(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPreViaPacketReceive(PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.STEER_VEHICLE && !player.inVehicle()
                && flag() && shouldModifyPackets()) {
            event.setCancelled(true);
            player.onPacketCancel();
        }
    }
}
