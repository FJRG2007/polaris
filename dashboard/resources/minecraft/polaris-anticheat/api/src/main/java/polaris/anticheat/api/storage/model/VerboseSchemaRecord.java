package polaris.anticheat.api.storage.model;

import polaris.anticheat.api.storage.codec.Id;
import polaris.anticheat.api.storage.codec.Indexed;
import polaris.anticheat.api.storage.codec.MergeMin;
import polaris.anticheat.api.storage.codec.Name;
import polaris.anticheat.api.storage.codec.Persistent;
import polaris.anticheat.api.storage.codec.Value;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

/**
 * Durable dictionary entry for one binary verbose layout.
 */
@ApiStatus.Experimental
@Persistent
public record VerboseSchemaRecord(
        @Id                                             @NotNull String schemaKey,
        @Indexed @Name("flavor")                       int flavor,
        @Indexed @Name("check_id")                     int checkId,
        @Value @Name("verbose_version")                int version,
        @Value @Name("layout")                         byte @NotNull [] layout,
        @Value @Name("introduced_at") @MergeMin        long introducedAt) {

    public VerboseSchemaRecord {
        if (schemaKey == null || schemaKey.isEmpty()) throw new IllegalArgumentException("schemaKey");
        if (version < 1) throw new IllegalArgumentException("version");
        if (layout == null) throw new IllegalArgumentException("layout");
    }

    public static @NotNull String keyOf(int flavor, int checkId, int version) {
        return flavor + ":" + checkId + ":" + version;
    }
}
