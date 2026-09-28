package polaris.anticheat.api.storage.config;

import org.jetbrains.annotations.ApiStatus;

@ApiStatus.Experimental
public record HistoryConfig(int entriesPerPage, long groupIntervalMs) {

    public static HistoryConfig defaults() {
        return new HistoryConfig(15, 30_000L);
    }
}
