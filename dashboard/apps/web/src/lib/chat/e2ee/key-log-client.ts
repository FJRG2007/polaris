/**
 * The browser half of the account key log (design 4.6): nothing the server
 * says about an account key is trusted until this module has checked it.
 *
 * Each answer of `/api/e2ee/key-log` is checked in full, or not used at all:
 * - the head is signed by the log key this browser saw first (trust on first
 *   use of the log, as a CT client pins its log's key), or by one that key
 *   handed over to, step by signed step; a change the old key never signed
 *   is a `log-reset`, followed only when the user says so;
 * - it is consistent with the last head this browser saw (RFC 9162 2.1.4):
 *   the log only ever grew, nothing was rewritten or dropped;
 * - every entry is included under it (RFC 9162 2.1.3).
 * Then the head is remembered, per signed-in account, in `localStorage`.
 *
 * A failed check is the server contradicting itself, never a network blip:
 * it is reported (`logProblem`) and the key is not trusted. An answer that
 * did not arrive is `unavailable`, which callers treat as "cannot say yet".
 *
 * Prior art: Certificate Transparency clients (RFC 6962/9162), CONIKS's
 * self-monitoring, WhatsApp's auditable key directory, IETF KEYTRANS.
 */

import { z } from "zod";
import * as log from "@polaris/chat-crypto/key-log";
import { fromText } from "@/lib/chat/e2ee/base64url";

const ROUTE = "/api/e2ee/key-log";
const PREFIX = "polaris:chat:key-log:";

/** A key the log vouches for. */
export interface VerifiedEntry {
    readonly index: number;
    readonly userId: string;
    readonly akVersion: number;
    readonly signPublicKey: Uint8Array;
    readonly hpkePublicKey: Uint8Array;
}

/**
 * `log-key`: the log signs with a key this browser cannot reach from the one it
 * pinned. `log-reset`: it can, but only through a change the old key never
 * signed (the server lost it: a master key change) - shown until the user
 * chooses to trust the new key (`trustLogReset`), never followed on its own.
 */
export type LogProblem = "log-key" | "log-reset" | "signature" | "rollback" | "consistency" | "inclusion";

export type LogCheck =
    | { readonly kind: "verified"; readonly entries: ReadonlyArray<VerifiedEntry>; readonly treeSize: number }
    | { readonly kind: "failed"; readonly problem: LogProblem }
    | { readonly kind: "unavailable" };

/** The last head this browser accepted, as stored. */
export interface SeenHead {
    readonly logKey: string;
    readonly treeSize: number;
    readonly rootHash: string;
}

const b64 = z.string().regex(/^[A-Za-z0-9_-]*$/).max(4096);
const answerSchema = z.object({
    logKey: b64,
    head: z.object({ treeSize: z.number().int().min(0), timestamp: z.number().int().min(0), rootHash: b64, signature: b64 }),
    consistency: z.array(b64).max(64).nullable(),
    entries: z
        .array(
            z.object({
                index: z.number().int().min(0),
                userId: z.string().uuid(),
                akVersion: z.number().int().min(1),
                signPublicKey: b64,
                hpkePublicKey: b64,
                proof: z.array(b64).max(64)
            })
        )
        .max(128),
    // Optional: a server from before hand-overs answers none, which is a chain only from the same key.
    handovers: z
        .array(
            z.object({
                fromKey: b64,
                toKey: b64,
                head: z.object({ treeSize: z.number().int().min(0), timestamp: z.number().int().min(0), rootHash: b64 }),
                signature: b64.nullable(),
                consistency: z.array(b64).max(64)
            })
        )
        .max(32)
        .default([])
});

type Answer = z.input<typeof answerSchema>;

export function readSeen(ownId: string): SeenHead | null {
    try {
        const raw = window.localStorage.getItem(PREFIX + ownId);
        if (!raw) return null;
        const value = JSON.parse(raw) as Partial<SeenHead>;
        if (typeof value.logKey !== "string" || typeof value.rootHash !== "string" || !Number.isSafeInteger(value.treeSize)) return null;
        return { logKey: value.logKey, treeSize: value.treeSize!, rootHash: value.rootHash };
    } catch {
        return null;
    }
}

function writeSeen(ownId: string, seen: SeenHead): void {
    try {
        // Only ever forward: a slower answer verified against an older head never rolls the memory back.
        const stored = readSeen(ownId);
        if (stored && stored.logKey === seen.logKey && stored.treeSize >= seen.treeSize) return;
        window.localStorage.setItem(PREFIX + ownId, JSON.stringify(seen));
    } catch {
        // Storage refused: consistency is then checked within this page only.
    }
}

const problems = new Map<string, LogProblem>();
const listeners = new Set<() => void>();

/** The last failed check for this account in this page, or null. */
export function logProblem(ownId: string): LogProblem | null {
    return problems.get(ownId) ?? null;
}

export function dismissLogProblem(ownId: string): void {
    if (problems.delete(ownId)) for (const listener of listeners) listener();
}

export function subscribeLog(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The log key each account was last shown through a reset, and the one its user chose to trust. */
const resetKeys = new Map<string, string>();
const trustedResets = new Map<string, string>();

/**
 * The user's answer to `log-reset`: trust the key the log was reset to, which
 * the next ask pins - still only if the log under it extends the head this
 * browser saw. Only that exact key: a later, different reset asks again.
 */
export function trustLogReset(ownId: string): void {
    const key = resetKeys.get(ownId);
    if (!key) return;
    trustedResets.set(ownId, key);
    resetKeys.delete(ownId);
    dismissLogProblem(ownId);
}

function report(ownId: string, problem: LogProblem): LogCheck {
    problems.set(ownId, problem);
    for (const listener of listeners) listener();
    return { kind: "failed", problem };
}

/**
 * Checks one answer against the head `seen` (null on first use); pure apart
 * from the hashing. A log key other than the pinned one is taken only through
 * the answer's hand-overs from it (`followHandovers`), each step's head a
 * prefix of the answer's head; a chain with a reset in it only when the user
 * already chose to trust exactly this key (`trustedReset`).
 */
export async function checkAnswer(answer: Answer, seen: SeenHead | null, trustedReset: string | null = null): Promise<LogCheck & { seen?: SeenHead }> {
    const logKey = fromText(answer.logKey);
    const steps: Array<log.KeyHandover & { consistency: Uint8Array[] }> = [];
    if (seen && seen.logKey !== answer.logKey) {
        const chain = (answer.handovers ?? []).map((h) => ({
            fromKey: fromText(h.fromKey),
            toKey: fromText(h.toKey),
            head: { treeSize: h.head.treeSize, timestamp: h.head.timestamp, rootHash: fromText(h.head.rootHash) },
            signature: h.signature === null ? null : fromText(h.signature),
            consistency: h.consistency.map(fromText)
        }));
        const followed = await log.followHandovers(fromText(seen.logKey), logKey, chain);
        if (followed.kind === "broken") return { kind: "failed", problem: "log-key" };
        if (followed.kind === "reset" && trustedReset !== answer.logKey) return { kind: "failed", problem: "log-reset" };
        steps.push(...(followed.links as typeof chain));
    }
    const head: log.TreeHead = {
        treeSize: answer.head.treeSize,
        timestamp: answer.head.timestamp,
        rootHash: fromText(answer.head.rootHash),
        signature: fromText(answer.head.signature)
    };
    if (!(await log.verifyHead(head, logKey))) return { kind: "failed", problem: "signature" };
    // A hand-over to a log that does not extend the one it was signed over is a fork, signed or not.
    for (const step of steps) {
        if (!(await log.verifyConsistency(step.head.treeSize, head.treeSize, step.head.rootHash, head.rootHash, step.consistency)))
            return { kind: "failed", problem: "consistency" };
    }
    if (seen) {
        if (head.treeSize < seen.treeSize) return { kind: "failed", problem: "rollback" };
        const proof = (answer.consistency ?? []).map(fromText);
        if (!answer.consistency && head.treeSize !== seen.treeSize) return { kind: "failed", problem: "consistency" };
        if (!(await log.verifyConsistency(seen.treeSize, head.treeSize, fromText(seen.rootHash), head.rootHash, proof)))
            return { kind: "failed", problem: "consistency" };
    }
    const entries: VerifiedEntry[] = [];
    for (const raw of answer.entries) {
        const entry = {
            index: raw.index,
            userId: raw.userId,
            akVersion: raw.akVersion,
            signPublicKey: fromText(raw.signPublicKey),
            hpkePublicKey: fromText(raw.hpkePublicKey)
        };
        const leaf = await log.entryLeafHash(entry);
        if (!(await log.verifyInclusion(entry.index, head.treeSize, leaf, raw.proof.map(fromText), head.rootHash)))
            return { kind: "failed", problem: "inclusion" };
        entries.push(entry);
    }
    return {
        kind: "verified",
        entries,
        treeSize: head.treeSize,
        seen: { logKey: answer.logKey, treeSize: head.treeSize, rootHash: answer.head.rootHash }
    };
}

/** One ask at a time per account, so each answer is checked against the head the one before it left. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Asks the log and checks the answer in full against this account's memory.
 * Asks for one account run in turn: two answers checked in parallel against
 * the same old head could each extend it on a different fork, and only the
 * larger would be remembered - the other fork's entries accepted unchecked
 * against it.
 */
export function askLog(ownId: string, body: { op: "proofs"; userIds: string[]; channelId?: string } | { op: "own" }): Promise<LogCheck> {
    const run = (queues.get(ownId) ?? Promise.resolve()).then(() => askOnce(ownId, body));
    const settled = run.catch(() => undefined);
    queues.set(ownId, settled);
    void settled.then(() => {
        if (queues.get(ownId) === settled) queues.delete(ownId);
    });
    return run;
}

async function askOnce(ownId: string, body: { op: "proofs"; userIds: string[]; channelId?: string } | { op: "own" }): Promise<LogCheck> {
    const seen = readSeen(ownId);
    let answer: Answer;
    try {
        const response = await fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ ...body, ...(seen ? { since: seen.treeSize, logKey: seen.logKey } : {}) })
        });
        if (!response.ok) return { kind: "unavailable" };
        const parsed = answerSchema.safeParse(await response.json());
        if (!parsed.success) return { kind: "unavailable" };
        answer = parsed.data;
    } catch {
        return { kind: "unavailable" };
    }
    const checked = await checkAnswer(answer, seen, trustedResets.get(ownId) ?? null);
    if (checked.kind === "failed") {
        if (checked.problem === "log-reset") resetKeys.set(ownId, answer.logKey);
        return report(ownId, checked.problem);
    }
    if (checked.kind === "verified" && checked.seen) {
        writeSeen(ownId, checked.seen);
        if (trustedResets.get(ownId) === checked.seen.logKey) trustedResets.delete(ownId);
    }
    return checked.kind === "verified" ? { kind: "verified", entries: checked.entries, treeSize: checked.treeSize } : checked;
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Whether `entry` carries exactly these public keys at this version. */
export function entryMatches(
    entry: VerifiedEntry | undefined,
    akVersion: number | null,
    keys: { signPublicKey: Uint8Array; hpkePublicKey: Uint8Array }
): boolean {
    if (!entry || (akVersion !== null && entry.akVersion !== akVersion)) return false;
    return equal(entry.signPublicKey, keys.signPublicKey) && equal(entry.hpkePublicKey, keys.hpkePublicKey);
}

/**
 * Of the account keys the server handed out in `channelId`, the accounts whose
 * key the log vouches for (`hpkePublicKey` is what every caller has, and
 * `signPublicKey` is compared too when given; a page of at most 100 - the
 * route refuses more). `null` when the log could not be asked; a key the log
 * contradicts is left out and reported.
 *
 * A key can also differ because its account rotated between the two asks:
 * the log answers the latest version, the keys were served a moment before.
 * So a mismatch is checked once more with keys served afresh (`refetch`):
 * when the fresh key is the one the log holds, the stale one is left out
 * (sealed to next time) but nothing is reported; only a key that still
 * differs - or no `refetch` to ask with - is the server contradicting itself.
 * A refetch that does not arrive reports nothing either: it cannot say.
 */
export async function vouchedAccounts(
    ownId: string,
    channelId: string,
    served: ReadonlyArray<ServedKey>,
    refetch?: (userIds: string[]) => Promise<ReadonlyArray<ServedKey> | null>
): Promise<Set<string> | null> {
    if (!served.length) return new Set();
    const check = await askLog(ownId, { op: "proofs", channelId, userIds: served.map((s) => s.userId) });
    if (check.kind === "unavailable") return null;
    if (check.kind === "failed") return new Set();
    const byUser = new Map(check.entries.map((e) => [e.userId, e]));
    const vouched = new Set<string>();
    const differing: string[] = [];
    for (const key of served) {
        if (servedMatches(byUser.get(key.userId), key)) vouched.add(key.userId);
        else differing.push(key.userId);
    }
    if (!differing.length) return vouched;
    const fresh = refetch ? await refetch(differing).catch(() => null) : undefined;
    if (fresh === null) return vouched;
    if (fresh === undefined) {
        report(ownId, "inclusion");
        return vouched;
    }
    const again = await askLog(ownId, { op: "proofs", channelId, userIds: differing });
    if (again.kind !== "verified") return vouched;
    const latest = new Map(again.entries.map((e) => [e.userId, e]));
    const freshByUser = new Map(fresh.map((key) => [key.userId, key]));
    // A key no longer served (they left, or removed it) is not a contradiction; one still served and still different is.
    if (differing.some((userId) => freshByUser.has(userId) && !servedMatches(latest.get(userId), freshByUser.get(userId)!))) report(ownId, "inclusion");
    return vouched;
}

/** An account key as the server handed it out. */
export interface ServedKey {
    readonly userId: string;
    readonly hpkePublicKey: Uint8Array;
    readonly signPublicKey?: Uint8Array;
}

function servedMatches(entry: VerifiedEntry | undefined, key: ServedKey): boolean {
    return !!entry && equal(entry.hpkePublicKey, key.hpkePublicKey) && (!key.signPublicKey || equal(entry.signPublicKey, key.signPublicKey));
}

/**
 * Own-entry monitoring (CONIKS, KEYTRANS): every key the log holds for this
 * account, checked against the key this browser itself holds. The indexes of
 * entries carrying a key this browser did not make - a substitute somebody
 * else is being handed - or null when the log could not be asked or checked.
 */
export async function foreignOwnEntries(
    ownId: string,
    held: { akVersion: number; signPublicKey: Uint8Array; hpkePublicKey: Uint8Array }
): Promise<VerifiedEntry[] | null> {
    const check = await askLog(ownId, { op: "own" });
    if (check.kind !== "verified") return null;
    // Older versions are the account's own history (rotation); the current one and anything newer must be this key.
    return check.entries.filter(
        (entry) => entry.userId !== ownId || (entry.akVersion >= held.akVersion && !entryMatches(entry, held.akVersion, held))
    );
}
