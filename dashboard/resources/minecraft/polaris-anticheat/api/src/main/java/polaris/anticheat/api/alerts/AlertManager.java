package polaris.anticheat.api.alerts;

import polaris.anticheat.api.PolarisUser;
import lombok.NonNull;
import org.bukkit.entity.Player;

public interface AlertManager {

    /**
     * Checks if the player has alerts enabled.
     *
     * @param player The PolarisUser to check
     * @return true if the player has alerts enabled, false otherwise
     * @throws NullPointerException if player is null
     */
    boolean hasAlertsEnabled(@NonNull PolarisUser player);

    /**
     * Toggles alerts for the player.
     * Sends a message to the player indicating the new state.
     *
     * @param player The PolarisUser to toggle alerts for
     * @return true if alerts are now enabled, false if alerts are now disabled
     * @throws NullPointerException if player is null
     */
    default boolean toggleAlerts(@NonNull PolarisUser player) {
        return toggleAlerts(player, false);
    }

    /**
     * Toggles alerts for the player silently or with a message.
     *
     * @param player The PolarisUser to toggle alerts for
     * @param silent true to suppress any messages to the player, false to notify
     * @return true if alerts are now enabled, false if alerts are now disabled
     * @throws NullPointerException if player is null
     */
    default boolean toggleAlerts(@NonNull PolarisUser player, boolean silent) {
        boolean newState = !hasAlertsEnabled(player);
        setAlertsEnabled(player, newState, silent);
        return newState;
    }

    /**
     * Sets the alert state for the player.
     * Sends a message to the player indicating the new state.
     *
     * @param player The PolarisUser to set alerts for
     * @param enabled true to enable alerts, false to disable
     * @throws NullPointerException if player is null
     */
    default void setAlertsEnabled(@NonNull PolarisUser player, boolean enabled) {
        setAlertsEnabled(player, enabled, false);
    }

    /**
     * Sets the alert state for the player silently or with a message.
     *
     * @param player The PolarisUser to set alerts for
     * @param enabled true to enable alerts, false to disable
     * @param silent true to suppress any messages to the player, false to notify
     * @throws NullPointerException if player is null
     */
    void setAlertsEnabled(@NonNull PolarisUser player, boolean enabled, boolean silent);

    // ------------------- VERBOSE -------------------

    /**
     * Checks if the player has verbose enabled.
     *
     * @param player The PolarisUser to check
     * @return true if the player has verbose enabled, false otherwise
     * @throws NullPointerException if player is null
     */
    boolean hasVerboseEnabled(@NonNull PolarisUser player);

    /**
     * Toggles verbose for the player.
     * Sends a message to the player indicating the new state.
     *
     * @param player The PolarisUser to toggle verbose for
     * @return true if verbose is now enabled, false if verbose is now disabled
     * @throws NullPointerException if player is null
     */
    default boolean toggleVerbose(@NonNull PolarisUser player) {
        return toggleVerbose(player, false);
    }

    /**
     * Toggles verbose for the player silently or with a message.
     *
     * @param player The PolarisUser to toggle verbose for
     * @param silent true to suppress any messages to the player, false to notify
     * @return true if verbose is now enabled, false if verbose is now disabled
     * @throws NullPointerException if player is null
     */
    default boolean toggleVerbose(@NonNull PolarisUser player, boolean silent) {
        boolean newState = !hasVerboseEnabled(player);
        setVerboseEnabled(player, newState, silent);
        return newState;
    }

    /**
     * Sets the verbose state for the player.
     * Sends a message to the player indicating the new state.
     *
     * @param player The PolarisUser to set verbose for
     * @param enabled true to enable verbose, false to disable
     * @throws NullPointerException if player is null
     */
    default void setVerboseEnabled(@NonNull PolarisUser player, boolean enabled) {
        setVerboseEnabled(player, enabled, false);
    }

    /**
     * Sets the verbose state for the player silently or with a message.
     *
     * @param player The PolarisUser to set verbose for
     * @param enabled true to enable verbose, false to disable
     * @param silent true to suppress any messages to the player, false to notify
     * @throws NullPointerException if player is null
     */
    void setVerboseEnabled(@NonNull PolarisUser player, boolean enabled, boolean silent);

    // ------------------- BRANDS -------------------

    /**
     * Checks if the player has brand notifications enabled.
     *
     * @param player The PolarisUser to check
     * @return true if the player has brand notifications enabled and has the "polarisac.brand" permission,
     *         false otherwise
     * @throws NullPointerException if player is null
     */
    boolean hasBrandsEnabled(@NonNull PolarisUser player);

    /**
     * Toggles brand notifications for the player.
     * Sends a message to the player indicating the new state.
     *
     * @param player The PolarisUser to toggle brand notifications for
     * @return true if brand notifications are now enabled, false if brand notifications are now disabled
     * @throws NullPointerException if player is null
     */
    default boolean toggleBrands(@NonNull PolarisUser player) {
        return toggleBrands(player, false);
    }

    /**
     * Toggles brand notifications for the player silently or with a message.
     *
     * @param player The PolarisUser to toggle brand notifications for
     * @param silent true to suppress any messages to the player, false to notify
     * @return true if brand notifications are now enabled, false if brand notifications are now disabled
     * @throws NullPointerException if player is null
     */
    default boolean toggleBrands(@NonNull PolarisUser player, boolean silent) {
        boolean newState = !hasBrandsEnabled(player);
        setBrandsEnabled(player, newState, silent);
        return newState;
    }

    /**
     * Sets the brand notification state for the player.
     * Sends a message to the player indicating the new state.
     *
     * @param player The PolarisUser to set brand notifications for
     * @param enabled true to enable brand notifications, false to disable
     * @throws NullPointerException if player is null
     */
    default void setBrandsEnabled(@NonNull PolarisUser player, boolean enabled) {
        setBrandsEnabled(player, enabled, false);
    }

    /**
     * Sets the brand notification state for the player silently or with a message.
     *
     * @param player The PolarisUser to set brand notifications for
     * @param enabled true to enable brand notifications, false to disable
     * @param silent true to suppress any messages to the player, false to notify
     * @throws NullPointerException if player is null
     */
    void setBrandsEnabled(@NonNull PolarisUser player, boolean enabled, boolean silent);

    /**
     * Checks if the player has alerts enabled.
     * @param player
     * @return boolean
     */
    @Deprecated boolean hasAlertsEnabled(Player player);

    /**
     * Toggles alerts for the player.
     * @param player
     */
    @Deprecated void toggleAlerts(Player player);
    /**
     * Checks if the player has verbose enabled.
     * @param player
     * @return boolean
     */
    @Deprecated
    boolean hasVerboseEnabled(Player player);

    /**
     * Toggles verbose for the player.
     * @param player
     */
    @Deprecated void toggleVerbose(Player player);
}