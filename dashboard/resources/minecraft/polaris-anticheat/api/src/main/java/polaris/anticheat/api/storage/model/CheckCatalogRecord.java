package polaris.anticheat.api.storage.model;

import polaris.anticheat.api.storage.codec.Id;
import polaris.anticheat.api.storage.codec.Indexed;
import polaris.anticheat.api.storage.codec.InsertOnly;
import polaris.anticheat.api.storage.codec.MergeMin;
import polaris.anticheat.api.storage.codec.Name;
import polaris.anticheat.api.storage.codec.Nullable;
import polaris.anticheat.api.storage.codec.Persistent;
import polaris.anticheat.api.storage.codec.Value;
import org.jetbrains.annotations.ApiStatus;

/**
 * Immutable v2 record for one entry in the check catalog. One row per
 * check, keyed primarily by {@code stableKey} (the human-readable
 * identifier the build artefact ships with, e.g. {@code "movement.simulation"});
 * the surrogate {@code checkId} integer is preserved as a secondary
 * unique index so legacy violation rows (which reference the int id)
 * keep working.
 * <p>
 * Mirrors the field set of the legacy
 * {@link polaris.anticheat.api.storage.check.CheckCatalogRow} so the v6→v7
 * Mongo migration can shuffle rows across without value transforms.
 * The legacy row stays as a separate type because the v1
 * {@code CheckCatalogPersistence} SPI still uses it; once the v1
 * persistence layer is retired (Phase 1.4d) the legacy class can be
 * deleted and consumers can switch to this record exclusively.
 */
@ApiStatus.Experimental
@Persistent
public record CheckCatalogRecord(
        @Id                                            @org.jetbrains.annotations.NotNull String stableKey,
        @Indexed @Name("check_id") @InsertOnly         int checkId,
        @Value @Nullable                               String display,
        @Value @Nullable                               String description,
        @Value @Name("introduced_version") @Nullable   String introducedVersion,
        // introducedAt is monotonically the EARLIEST observed
        // registration time across all servers that ever ran with
        // this stableKey. @MergeMin keeps the earliest value when
        // multiple instances upsert.
        @Value @Name("introduced_at") @MergeMin        long introducedAt) {

    public CheckCatalogRecord {
        if (stableKey == null) throw new IllegalArgumentException("stableKey");
        if (stableKey.isEmpty()) throw new IllegalArgumentException("stableKey must not be empty");
    }
}
