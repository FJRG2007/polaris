package polaris.anticheat.manager;

import polaris.anticheat.manager.tick.Tickable;
import polaris.anticheat.manager.tick.impl.ClearRecentlyUpdatedBlocks;
import polaris.anticheat.manager.tick.impl.ClientVersionSetter;
import polaris.anticheat.manager.tick.impl.ResetTick;
import polaris.anticheat.manager.tick.impl.TickInventory;
import polaris.anticheat.manager.tick.impl.TickPermissions;
import com.google.common.collect.ClassToInstanceMap;
import com.google.common.collect.ImmutableClassToInstanceMap;

public class TickManager {
    // Overflows after 4 years of uptime
    public int currentTick;
    private final ClassToInstanceMap<Tickable> syncTick;
    private final ClassToInstanceMap<Tickable> asyncTick;

    public TickManager() {
        syncTick = new ImmutableClassToInstanceMap.Builder<Tickable>()
                .put(ResetTick.class, new ResetTick())
                .build();

        asyncTick = new ImmutableClassToInstanceMap.Builder<Tickable>()
                .put(ClientVersionSetter.class, new ClientVersionSetter()) // Async because permission lookups might take a while, depending on the plugin
                .put(TickPermissions.class, new TickPermissions())
                .put(TickInventory.class, new TickInventory()) // Async because I've never gotten an exception from this.  It's probably safe.
                .put(ClearRecentlyUpdatedBlocks.class, new ClearRecentlyUpdatedBlocks())
                .build();
    }

    public void tickSync() {
        currentTick++;
        for (Tickable tickable : syncTick.values()) {
            tickable.tick();
        }
    }

    public void tickAsync() {
        for (Tickable tickable : asyncTick.values()) {
            tickable.tick();
        }
    }
}
