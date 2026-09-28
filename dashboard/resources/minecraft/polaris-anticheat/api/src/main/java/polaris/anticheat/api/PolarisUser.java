package polaris.anticheat.api;

import polaris.anticheat.api.common.BasicReloadable;
import polaris.anticheat.api.config.ConfigReloadable;
import polaris.anticheat.api.feature.FeatureManager;
import polaris.anticheat.api.handler.UserHandlerHolder;
import org.jetbrains.annotations.Nullable;

import java.util.Collection;
import java.util.UUID;

public interface PolarisUser extends ConfigReloadable, BasicReloadable, UserHandlerHolder, PolarisIdentity {

    String getName();

    String getBrand();

    @Nullable String getWorldName();

    @Nullable UUID getWorldUID();

    PacketWorld getPacketWorld();

    int getTransactionPing();

    int getKeepAlivePing();

    String getVersionName();

    double getHorizontalSensitivity();

    double getVerticalSensitivity();

    boolean isVanillaMath();

    void updatePermissions();

    Collection<? extends AbstractCheck> getChecks();

    /**
     * Runs the runnable on the player's netty thread. This may need to be used
     * to access parts of the API safely. This might be removed in future for
     * simplicity.
     *
     * @param runnable
     */
    void runSafely(Runnable runnable);

    /**
     * Retrieves the last transaction received by the player.
     */
    int getLastTransactionReceived();

    /**
     * Retrieves the last transaction sent by the player.
     */
    int getLastTransactionSent();

    /**
     * Schedules a task to run based on the player's transaction.
     * This needs to be executed on the player's netty thread. You can use {@link PolarisUser#runSafely(Runnable)} to ensure this.
     *
     * @param transaction If the player's transaction is greater than or equal to this, the task will run
     * @param runnable    The task that should run
     */
    void addRealTimeTask(int transaction, Runnable runnable);

    default void addRealTimeTaskNow(Runnable runnable) {
        addRealTimeTask(getLastTransactionSent(), runnable);
    }

    default void addRealTimeTaskNext(Runnable runnable) {
        addRealTimeTask(getLastTransactionSent() + 1, runnable);
    }

    /**
     * An easier way to manage per player features that's persistent between reloads.
     */
    FeatureManager getFeatureManager();

    /**
     * Sends a message to the player.
     * @param message Message to send
     */
    void sendMessage(String message);

    boolean hasPermission(String permission);
}
