/**
 * The non-secret settings an install carries, as they are read.
 *
 * Kept apart from the write, which needs the database: reading one is a JSON
 * parse, and it is done on every screen that draws an install - and by the
 * installable apps, which take it from the host and must not pull the database
 * in behind it.
 */

export type InstallConfig = Record<string, unknown>;

/** The config as an object. A column that is not readable JSON reads as empty -
 *  it is a settings blob, and no caller should fail to render over one. */
export function readInstallConfig(raw: string | null | undefined): InstallConfig {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as InstallConfig)
            : {};
    } catch {
        return {};
    }
}
