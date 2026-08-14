/**
 * Polaris keeps its per-connection bookkeeping inside a single hidden ".polaris"
 * folder on the storage backend (the recycle bin and the malware quarantine live
 * under it). These are hidden from the file browser and skipped by the recursive
 * search / zip / recent walks so they never surface as user content. Older
 * installs used sibling ".polaris-trash" / ".polaris-quarantine" folders; those
 * are still treated as reserved so anything left behind stays hidden too.
 *
 * `isReservedRootPath` is for those read-side listings, which only ever ask about
 * one folder's own entries. Anything that deletes or moves by path - see
 * `isReservedPath` and `@/lib/drive-delete` - needs the stricter check, since a
 * caller can name the bin itself instead of merely listing past it.
 */

/** The one hidden folder that holds all of Polaris's per-connection data. */
export const POLARIS_DIR = ".polaris";
/** Recycle bin: trashed items are moved here before permanent deletion. */
export const TRASH_DIR = `${POLARIS_DIR}/trash`;
/** Where the scanner isolates uploads flagged as unsafe. */
export const QUARANTINE_DIR = `${POLARIS_DIR}/quarantine`;

/** Pre-consolidation locations, kept reserved so leftovers never reappear. */
const LEGACY_ROOTS = [".polaris-trash", ".polaris-quarantine"];

/** Whether a root-level entry path is Polaris-internal and must stay hidden. */
export function isReservedRootPath(path: string): boolean {
    return path === POLARIS_DIR || LEGACY_ROOTS.includes(path);
}

/**
 * Whether a path is one of the reserved folders or anything inside one.
 *
 * Listings only ever ask about the entries of one folder, so matching the name is
 * enough for them. A caller naming a path outright - a delete, a move - can name
 * the bin itself, and hiding the folder while allowing ".polaris/trash" through
 * protects nothing. Only the root's own copies are reserved: a nested
 * "Archive/.polaris" is somebody's folder that happens to share the name.
 */
export function isReservedPath(path: string): boolean {
    return [POLARIS_DIR, ...LEGACY_ROOTS].some(
        (root) => path === root || path.startsWith(`${root}/`)
    );
}
