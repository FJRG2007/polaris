package polaris.anticheat.api.storage.query;

import org.jetbrains.annotations.ApiStatus;

/**
 * Marker for a typed, category-scoped query. Concrete subtypes live in {@link Queries}.
 * <p>
 * Not general predicate language — each Query subtype names a specific backend-friendly
 * access pattern that every backend can implement without a full query planner.
 *
 * @deprecated Replaced by {@link polaris.anticheat.api.storage.kind.Operation} plus the
 * per-Kind operation menus on {@link polaris.anticheat.api.storage.category.EventStreamCategory},
 * {@link polaris.anticheat.api.storage.category.EntityCategory}, etc. The redesign moves
 * dispatch from "switch on Query record" to "execute Operation on the routed KindAdapter".
 * See {@code .docs/storage-redesign/01-data-kinds.md}.
 */
@ApiStatus.Experimental
@Deprecated(forRemoval = true, since = "phase0")
public interface Query<R> {}
