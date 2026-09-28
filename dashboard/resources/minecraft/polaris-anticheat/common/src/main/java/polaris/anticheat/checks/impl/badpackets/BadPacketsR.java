package polaris.anticheat.checks.impl.badpackets;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PacketReceiveListener;
import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;

@CheckData(name = "BadPacketsR", stableKey = "polarisac.badpackets.position_starvation", description = "Stopped sending position updates while still responding to transactions", decay = 0.25, experimental = true)
public class BadPacketsR extends Check implements PacketReceiveListener {
    private static final Verbose V = Verbose.of("time={ulong}ms, lst={ulong}ms, positions={uint}");

    private int positions = 0;
    private long clock = 0;
    private long lastTransTime;
    private int oldTransId = 0;

    public BadPacketsR(final PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPacketReceive(final PacketReceiveEvent event) {
        if (isTransaction(event.getPacketType()) && player.packetStateData.lastTransactionPacketWasValid) {
            long ms = (player.getPlayerClockAtLeast() - clock) / 1000000L;
            long diff = (System.currentTimeMillis() - lastTransTime);
            if (diff > 2000 && ms > 2000) {
                if (positions == 0 && clock != 0 && player.cameraEntity.isSelf() && !player.compensatedEntities.self.isDead) {
                    flag(V.write(verbose()).ulong(ms).ulong(diff).uint(positions));
                } else {
                    reward();
                }
                player.compensatedEntities.entitiesRemovedThisTick.clear();
                player.compensatedWorld.removeInvalidPistonLikeStuff(oldTransId);
                positions = 0;
                clock = player.getPlayerClockAtLeast();
                lastTransTime = System.currentTimeMillis();
                oldTransId = player.lastTransactionSent.get();
            }
        }
        //
        if ((event.getPacketType() == PacketType.Play.Client.PLAYER_POSITION_AND_ROTATION ||
                event.getPacketType() == PacketType.Play.Client.PLAYER_POSITION) && !player.inVehicle()) {
            positions++;
        } else if ((event.getPacketType() == PacketType.Play.Client.STEER_VEHICLE || event.getPacketType() == PacketType.Play.Client.VEHICLE_MOVE)
                && player.inVehicle()) {
            positions++;
        }
    }

}
