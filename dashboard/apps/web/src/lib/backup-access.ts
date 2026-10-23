/**
 * Whether backup access is serving the domain right now.
 *
 * The seam for the backup-access work: while it is active it owns the domain's
 * records, and the public-address follower (`domain-address-sync`) stands back so
 * the two never write the same record. Nothing turns it on yet.
 */
export async function backupAccessActive(): Promise<boolean> {
    return false;
}
