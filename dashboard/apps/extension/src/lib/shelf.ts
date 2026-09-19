/**
 * Which logins belong on the shelf that is open.
 *
 * The same rule the dashboard's vault screen follows: on an organization's shelf,
 * that organization's vault; on your own, your vault and any personal one
 * somebody let you into. A vault is recognised as an organization's by the id the
 * server paired it with, so a personal vault shared with you - which is not any
 * organization's - stays on your own shelf.
 *
 * Pure, and apart from the worker, so it can be checked without a browser.
 */

export interface ShelfOrganization {
    readonly id: string;
    readonly vaultId: string | null;
}

/**
 * Whether a login from this vault (null for the account's own) is shown while
 * `shelf` is open (null for the personal shelf).
 */
export function onShelf(
    vaultId: string | null,
    shelf: string | null,
    organizations: readonly ShelfOrganization[]
): boolean {
    if (shelf === null) {
        return vaultId === null || !organizations.some((org) => org.vaultId === vaultId);
    }
    const org = organizations.find((one) => one.id === shelf);
    // An organization that is no longer the account's shows nothing rather than
    // everything: the worker puts the shelf back to personal on its next check.
    return org !== undefined && org.vaultId !== null && vaultId === org.vaultId;
}
