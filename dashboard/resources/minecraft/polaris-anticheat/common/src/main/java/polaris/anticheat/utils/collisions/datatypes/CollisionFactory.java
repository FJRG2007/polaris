package polaris.anticheat.utils.collisions.datatypes;

import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.world.states.WrappedBlockState;

public interface CollisionFactory {
    CollisionBox fetch(PolarisPlayer player, ClientVersion version, WrappedBlockState block, int x, int y, int z);
}
