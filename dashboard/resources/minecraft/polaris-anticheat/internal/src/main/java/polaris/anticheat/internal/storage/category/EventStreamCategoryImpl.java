package polaris.anticheat.internal.storage.category;

import polaris.anticheat.api.storage.category.Capability;
import polaris.anticheat.api.storage.category.Category;
import polaris.anticheat.api.storage.category.EventStreamCategory;
import polaris.anticheat.api.storage.kind.EventStream;
import polaris.anticheat.api.storage.registry.StoreId;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

import java.util.EnumSet;
import java.util.function.Supplier;

/**
 * Concrete {@link EventStreamCategory}. Carries everything needed to dispatch
 * operations: the id (used for ring routing + legacy-Category equality), the
 * Kind (used by KindAdapter), and the registered StoreId.
 * <p>
 * Pure v2 category — does not delegate to any legacy {@link Category}.
 * Phase 1.4c will arrange for {@code DataStore.submit} writes destined for
 * this category to share the same instance with the read/op path so
 * {@link V2Routes} identity-keyed lookups match.
 */
@ApiStatus.Internal
public final class EventStreamCategoryImpl<E, R> implements EventStreamCategory<E, R> {

    private final @NotNull String id;
    private final @NotNull EventStream<E, R> kind;
    private final @NotNull StoreId storeId;

    public EventStreamCategoryImpl(@NotNull String id, @NotNull StoreId storeId, @NotNull EventStream<E, R> kind) {
        this.id = id;
        this.storeId = storeId;
        this.kind = kind;
    }

    @Override public @NotNull String id() { return id; }
    @Override public @NotNull EventStream<E, R> kind() { return kind; }
    public  @NotNull StoreId storeId() { return storeId; }

    // ---- Category<E> contract ----

    @Override public @NotNull Class<E> eventType() { return kind.eventType(); }
    @Override public @NotNull Supplier<E> newEvent() { return kind.newEvent(); }
    @Override public @NotNull Class<?> queryResultType() { return kind.recordType(); }

    @Override
    public @NotNull EnumSet<Capability> requiredCapabilities() {
        return kind.requiredCapabilities();
    }

    @SuppressWarnings({"deprecation", "removal"})
    @Override
    public @NotNull polaris.anticheat.api.storage.category.AccessPattern accessPattern() {
        // Legacy enum bridge. The Kind subsumes AccessPattern under the
        // redesign; this default keeps registration validators that still
        // consult accessPattern() happy until they're updated to read kind().
        return polaris.anticheat.api.storage.category.AccessPattern.TIMESERIES;
    }
}
