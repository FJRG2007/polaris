package polaris.anticheat.utils.data.packetentity;

public interface DashableEntity {

    boolean isDashing();

    void setDashing(boolean dashing);

    int getDashCooldown();

    void setDashCooldown(int dashCooldown);

}
