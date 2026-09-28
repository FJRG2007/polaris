package polaris.anticheat.utils.data.packetentity;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.data.VectorData;

import java.util.Set;

public interface JumpableEntity {

    boolean isJumping();

    void setJumping(boolean jumping);

    float getJumpPower();

    void setJumpPower(float jumpPower);

    boolean canPlayerJump(PolarisPlayer player);

    boolean hasSaddle();

    void executeJump(PolarisPlayer player, Set<VectorData> possibleVectors);

}
