/**
 * What goes into a folder sent as a service's source, and how much of it.
 *
 * The same rules the dashboard's browser zipper applies
 * (`dashboard/apps/web/src/app/(app)/apps/deploy/upload-source.tsx`), so a folder
 * picked here and one dropped in the browser arrive as the same zip: no
 * `node_modules`, no `.git`, no macOS resource forks or `.DS_Store`, and the same
 * two ceilings with the same words. The server skips the same entries again, so
 * this is about not sending them, not about what gets built.
 */

/** The largest zip the server takes, and the most a folder may hold before it. */
export const MAX_ZIP = 200 * 1024 ** 2;
export const MAX_FOLDER = 1024 ** 3;

const SKIPPED = new Set(["node_modules", ".git", "__MACOSX"]);

/** Whether a path inside the picked folder, written with `/`, is left out. A
 *  folder that matches is left out with everything in it. */
export function skipped(path: string): boolean {
    return path.split("/").some((segment) => SKIPPED.has(segment)) || path.endsWith(".DS_Store");
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** "1.5 GB" - the same arithmetic as `formatBytes` in `@polaris/core`, so a
 *  limit reads the same here as it does in the dashboard. */
export function formatBytes(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
    return `${rounded} ${UNITS[unit]}`;
}

export const EMPTY_FOLDER = "There are no files in that folder.";
export const FOLDER_TOO_LARGE = `That folder holds more than ${formatBytes(MAX_FOLDER)}.`;
export const ZIP_TOO_LARGE = `Zipped, that folder is larger than ${formatBytes(MAX_ZIP)}.`;
