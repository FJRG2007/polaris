package polaris.minecraft;

import io.papermc.paper.event.player.PlayerPickBlockEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;

/**
 * Pick block on a seasonal decoration gives the decoration (Paper 1.21.4 and
 * later, where the server answers a pick; {@link SeasonalDecor} loads this only
 * there). The world holds the grass under a pumpkin a player is only shown, so
 * left to the server the pick gave that.
 */
final class SeasonalDecorPick implements Listener {
    private final SeasonalDecor decor;

    SeasonalDecorPick(SeasonalDecor decor) {
        this.decor = decor;
    }

    @EventHandler(ignoreCancelled = true)
    public void onPick(PlayerPickBlockEvent event) {
        if (decor.pick(event.getPlayer(), event.getBlock())) event.setCancelled(true);
    }
}
