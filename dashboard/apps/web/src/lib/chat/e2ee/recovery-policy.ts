/**
 * The rules of quorum recovery that both sides need, with nothing to import:
 * who holds an account's shares, how many of them recover it, how long a
 * request stays open, and when a browser must split its key again.
 *
 * Defaults, the owner may change (docs/chat-e2ee-mls.md, "Recovery"): up to 3
 * custodians and 2 of them recover; an organisation with a single administrator
 * recovers with 1 of 1, and that administrator is told; 2 administrators make
 * 2 of 2. A request stays open 7 days.
 */

export const MAX_CUSTODIANS = 3;
export const QUORUM = 2;
export const REQUEST_DAYS = 7;
export const REQUEST_MS = REQUEST_DAYS * 24 * 60 * 60 * 1000;
/** How recently an administrator-approved account recovery must have been used. */
export const RECOVERY_WINDOW_MS = REQUEST_MS;

/** "org:<id>" for an organisation's administrators, "instance" for the instance's. */
export type RecoveryScope = `org:${string}` | "instance";

export interface CustodianKey {
    readonly userId: string;
    readonly akVersion: number;
}

/**
 * The custodians, in the order given (the caller orders them: owner first, then
 * administrators by how long they have been one), and the threshold. Never the
 * account itself, never twice, only accounts with a key to seal to.
 */
export function chooseCustodians<T extends CustodianKey>(
    ownerId: string,
    candidates: ReadonlyArray<T | null | undefined>
): { custodians: T[]; threshold: number } {
    const seen = new Set<string>([ownerId]);
    const custodians: T[] = [];
    for (const candidate of candidates) {
        if (!candidate || seen.has(candidate.userId)) continue;
        seen.add(candidate.userId);
        custodians.push(candidate);
        if (custodians.length === MAX_CUSTODIANS) break;
    }
    return { custodians, threshold: Math.min(QUORUM, custodians.length) };
}

export interface StoredShare {
    readonly custodianId: string;
    readonly custodianAkVersion: number;
    readonly akVersion: number;
    readonly splitId: string;
    readonly threshold: number;
    readonly scope: string;
}

/**
 * Whether the stored shares no longer match: another custodian set, threshold,
 * scope or key version on either side, or shares from more than one split.
 * No custodian at all means nothing to hold shares, so nothing to redo.
 */
export function needsSplit(
    akVersion: number,
    wanted: { scope: string; threshold: number; custodians: ReadonlyArray<CustodianKey> },
    stored: ReadonlyArray<StoredShare>
): boolean {
    if (wanted.custodians.length === 0) return stored.length > 0;
    if (stored.length !== wanted.custodians.length) return true;
    if (new Set(stored.map((share) => share.splitId)).size !== 1) return true;
    const byCustodian = new Map(stored.map((share) => [share.custodianId, share]));
    return wanted.custodians.some((custodian) => {
        const share = byCustodian.get(custodian.userId);
        return (
            !share ||
            share.custodianAkVersion !== custodian.akVersion ||
            share.akVersion !== akVersion ||
            share.threshold !== wanted.threshold ||
            share.scope !== wanted.scope
        );
    });
}
