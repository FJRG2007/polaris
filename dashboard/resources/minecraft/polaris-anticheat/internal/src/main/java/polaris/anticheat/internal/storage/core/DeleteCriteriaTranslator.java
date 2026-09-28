package polaris.anticheat.internal.storage.core;

import polaris.anticheat.api.storage.category.Categories;
import polaris.anticheat.api.storage.category.Category;
import polaris.anticheat.api.storage.kind.Operation;
import polaris.anticheat.api.storage.kind.ops.EntityOps;
import polaris.anticheat.api.storage.kind.ops.EventStreamOps;
import polaris.anticheat.api.storage.kind.ops.KeyValueScopedOps;
import polaris.anticheat.api.storage.model.SettingScope;
import polaris.anticheat.api.storage.query.DeleteCriteria;
import polaris.anticheat.api.storage.query.Deletes;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.Nullable;

/**
 * Translates legacy {@link DeleteCriteria} into the equivalent v2
 * {@link Operation} so {@code DataStoreImpl.delete()} can dispatch
 * through the v2 adapter when a v2 route exists. Returns {@code null}
 * for untranslatable criteria (e.g. unknown category or criteria type)
 * — the caller falls back to legacy {@code Backend.delete()}.
 */
@ApiStatus.Internal
final class DeleteCriteriaTranslator {

    private DeleteCriteriaTranslator() {}

    @SuppressWarnings({"unchecked", "rawtypes"})
    static @Nullable Operation<Void> translate(Category<?> cat, DeleteCriteria criteria) {
        if (criteria instanceof Deletes.ByPlayer bp) {
            if (cat == Categories.VIOLATION) {
                return (Operation) new EventStreamOps.DeleteByPartitionOp(cat,
                    "player_uuid", bp.uuid());
            }
            if (cat == Categories.PLAYER_IDENTITY) {
                return (Operation) new EntityOps.DeleteByIdOp(cat, bp.uuid());
            }
            if (cat == Categories.SESSION) {
                // Route through the by_player_started compound index —
                // leading column is player_uuid, so equality on it lets
                // the backend pick the index and delete every matching
                // row in one round-trip. Mirrors the read-side
                // Queries.listSessionsByPlayer routing.
                return (Operation) new EntityOps.DeleteByIndexOp(cat,
                    "by_player_started", bp.uuid());
            }
            if (cat == Categories.SETTING) {
                // Drop every key under the player's KV tenant — one
                // round-trip per backend. Mirrors how the v2 KV adapter
                // composes the (scope, scope_key) tenant id.
                return (Operation) new KeyValueScopedOps.RemoveAllOp<>(cat,
                    SettingScope.PLAYER, bp.uuid().toString());
            }
        }
        if (criteria instanceof Deletes.OlderThan ot) {
            if (cat == Categories.VIOLATION) {
                long cutoff = System.currentTimeMillis() - ot.maxAgeMs();
                return (Operation) new EventStreamOps.DeleteOlderThanOp(cat, cutoff);
            }
            // SESSION olderThan: no v2 Entity "delete by timestamp
            // range" Op exists yet. Fall back to legacy.
        }
        return null;
    }
}
