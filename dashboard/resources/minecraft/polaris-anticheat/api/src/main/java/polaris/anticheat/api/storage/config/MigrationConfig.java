package polaris.anticheat.api.storage.config;

import org.jetbrains.annotations.ApiStatus;

/**
 * Controls the one-shot <strong>V0 → V1 history migration</strong> that runs on
 * first boot after an operator upgrades from a pre-v1 Polaris build.
 * <p>
 * V0 is the legacy history layout: a single {@code violations.sqlite} file
 * written by older Polaris versions (pre-database-redesign), populated through
 * the original {@code ViolationDatabaseManager} write path.
 * <p>
 * V1 is the current layout: a split {@code history.v1.db} (SQLite) or an
 * equivalent in a networked backend (future MySQL / Postgres / Mongo), written
 * through the {@link polaris.anticheat.api.storage.DataStore} event ring and read
 * by {@link polaris.anticheat.api.storage.history.HistoryService}.
 * <p>
 * When an operator boots Polaris with this feature for the first time and a V0
 * file is present in the plugin data folder, Polaris walks the V0 rows and
 * bulk-imports them into the routed backend for the violation category so
 * {@code /polarisac history} remains continuous across the upgrade. The migration
 * resumes from the last committed row if the server is restarted mid-run.
 * <p>
 * Once complete, the V0 file is left in place (read-only safety net — Polaris
 * never writes to it) and this config no longer has any effect until an
 * operator manually restores a fresh V0 file.
 *
 * @param skip           If true, the V0 file (if present) is ignored on boot.
 *                       Set this when an operator plans to carry history over
 *                       manually later via {@code /polarisac history copy} or
 *                       similar, or never wants the old rows visible in V1.
 * @param maxDurationMs  Soft cap on how long the V0 → V1 pass may run before
 *                       pausing. {@code 0} means no cap — let it run to
 *                       completion. Non-zero values park the run at the next
 *                       safe checkpoint and resume on the next boot; useful
 *                       for operators with large V0 databases who don't want
 *                       a multi-minute import blocking every startup.
 */
@ApiStatus.Experimental
public record MigrationConfig(boolean skip, long maxDurationMs) {

    public static MigrationConfig defaults() {
        return new MigrationConfig(false, 0L);
    }
}
