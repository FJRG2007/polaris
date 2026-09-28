package polaris.anticheat.api.events;

import polaris.anticheat.api.PolarisUser;
import org.bukkit.event.Event;
import org.bukkit.event.HandlerList;
import org.jetbrains.annotations.NotNull;

@Deprecated(since = "1.2.1.0", forRemoval = true)
public class PolarisJoinEvent extends Event implements PolarisUserEvent {

    private static final HandlerList handlers = new HandlerList();
    private final PolarisUser user;

    public PolarisJoinEvent(PolarisUser user) {
        super(true); // Async!
        this.user = user;
    }

    @Override
    public PolarisUser getUser() {
        return user;
    }

    @NotNull
    @Override
    public HandlerList getHandlers() {
        return handlers;
    }

    public static HandlerList getHandlerList() {
        return handlers;
    }

}
