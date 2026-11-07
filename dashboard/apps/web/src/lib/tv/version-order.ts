/**
 * Ordering Polaris TV versions. Client-safe: /account/tv decides with it which
 * TVs are current, and which can be updated from there.
 */

/** Dotted numeric comparison of two TV versions ("3.10" is newer than "3.9").
 *  Segments that are not numbers compare as text. */
export function compareTvVersions(left: string, right: string): number {
    const a = left.split(/[.+-]/);
    const b = right.split(/[.+-]/);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const x = a[index] ?? "0";
        const y = b[index] ?? "0";
        const nx = Number(x);
        const ny = Number(y);
        const order = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
        if (order !== 0) return Math.sign(order);
    }
    return 0;
}

/** Whether a TV carries out an update request. Only a launcher that does reports
 *  its build number (`versionCode`); one that names its version only in its user
 *  agent never collects the request. */
export function tvTakesUpdates(versionCode: number | null): boolean {
    return versionCode !== null;
}

/** The first launcher build that carries out Block ads and trackers asked from
 *  Polaris and says how it went. */
export const TV_BLOCKING_MIN_CODE = 14;

/** Whether a TV acts on Block ads and trackers asked from /account/tv. */
export function tvTakesBlocking(versionCode: number | null): boolean {
    return versionCode !== null && versionCode >= TV_BLOCKING_MIN_CODE;
}

/** The first launcher build that applies a theme and installs add-ons asked from
 *  Polaris and says how it went. */
export const TV_CATALOG_MIN_CODE = 16;

/** Whether a TV acts on a theme or add-ons picked from /account/tv. */
export function tvTakesCatalog(versionCode: number | null): boolean {
    return versionCode !== null && versionCode >= TV_CATALOG_MIN_CODE;
}
