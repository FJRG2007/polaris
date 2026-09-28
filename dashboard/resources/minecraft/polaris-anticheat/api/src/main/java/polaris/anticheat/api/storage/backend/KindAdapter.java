package polaris.anticheat.api.storage.backend;

import polaris.anticheat.api.storage.category.Capability;
import polaris.anticheat.api.storage.category.Category;
import polaris.anticheat.api.storage.kind.DataKind;
import polaris.anticheat.api.storage.kind.Operation;
import polaris.anticheat.api.storage.registry.Migration;
import polaris.anticheat.api.storage.registry.StoreId;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

import java.util.EnumSet;
import java.util.List;

/**
 * Per-(Backend, Kind) implementation SPI. Owns physical layout for one
 * {@link DataKind} on one backend. See
 * {@code .docs/storage-redesign/03-backends-and-adapters.md}.
 *
 * @param <K> the DataKind type this adapter handles
 */
@ApiStatus.Experimental
public interface KindAdapter<K extends DataKind<?, ?>> {

    @NotNull Class<K> kindType();

    /** Subcapabilities advertised in addition to the {@code KIND_*} marker. */
    @NotNull EnumSet<Capability> subcapabilities();

    /** Create or update the physical store. Idempotent. */
    void ensureStore(@NotNull StoreId id, @NotNull K kind) throws BackendException;

    /** Drop the physical store. Called only when an extension is uninstalled with data removal. */
    void dropStore(@NotNull StoreId id, @NotNull K kind) throws BackendException;

    /**
     * Write handler wired into the Disruptor ring for this category. Called
     * once at startup; the returned handler owns per-batch state.
     */
    <E> @NotNull StorageEventHandler<E> writeHandler(@NotNull StoreId id, @NotNull K kind, @NotNull Category<E> category);

    /**
     * Execute a read or mutation operation. Synchronous, called on the
     * reader pool by {@code DataStoreImpl}; throw on error.
     */
    <R> R execute(@NotNull StoreId id, @NotNull K kind, @NotNull Operation<R> op) throws BackendException;

    /** Migrations for this Kind, in order from lowest source version. */
    @NotNull List<Migration<K>> migrations(@NotNull K kind);
}
