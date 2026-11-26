/**
 * The browser half of the account key log (design 4.6): nothing the server
 * says about an account key is trusted until this module has checked it.
 *
 * Each answer of `/api/e2ee/key-log` is checked in full, or not used at all:
 * - the head is signed by the log key this browser saw first (trust on first
 *   use of the log, as a CT client pins its log's key);
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

export type LogProblem = "log-key" | "signature" | "rollback" | "consistency" | "inclusion";

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
        .max(128)
});

type Answer = z.infer<typeof answerSchema>;

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

function report(ownId: string, problem: LogProblem): LogCheck {
    problems.set(ownId, problem);
    for (const listener of listeners) listener();
    return { kind: "failed", problem };
}

/** Checks one answer against the head `seen` (null on first use); pure apart from the hashing. */
export async function checkAnswer(answer: Answer, seen: SeenHead | null): Promise<LogCheck & { seen?: SeenHead }> {
    const logKey = fromText(answer.logKey);
    if (seen && seen.logKey !== answer.logKey) return { kind: "failed", problem: "log-key" };
    const head: log.TreeHead = {
        treeSize: answer.head.treeSize,
        timestamp: answer.head.timestamp,
        rootHash: fromText(answer.head.rootHash),
        signature: fromText(answer.head.signature)
    };
    if (!(await log.verifyHead(head, logKey))) return { kind: "failed", problem: "signature" };
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
            body: JSON.stringify({ ...body, ...(seen ? { since: seen.treeSize } : {}) })
        });
        if (!response.ok) return { kind: "unavailable" };
        const parsed = answerSchema.safeParse(await response.json());
        if (!parsed.success) return { kind: "unavailable" };
        answer = parsed.data;
    } catch {
        return { kind: "unavailable" };
    }
    const checked = await checkAnswer(answer, seen);
    if (checked.kind === "failed") return report(ownId, checked.problem);
    if (checked.kind === "verified" && checked.seen) writeSeen(ownId, checked.seen);
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
 */
export async function vouchedAccounts(
    ownId: string,
    channelId: string,
    served: ReadonlyArray<{ userId: string; hpkePublicKey: Uint8Array; signPublicKey?: Uint8Array }>
): Promise<Set<string> | null> {
    if (!served.length) return new Set();
    const check = await askLog(ownId, { op: "proofs", channelId, userIds: served.map((s) => s.userId) });
    if (check.kind === "unavailable") return null;
    if (check.kind === "failed") return new Set();
    const byUser = new Map(check.entries.map((e) => [e.userId, e]));
    const vouched = new Set<string>();
    for (const key of served) {
        const entry = byUser.get(key.userId);
        if (entry && equal(entry.hpkePublicKey, key.hpkePublicKey) && (!key.signPublicKey || equal(entry.signPublicKey, key.signPublicKey)))
            vouched.add(key.userId);
        else report(ownId, "inclusion");
    }
    return vouched;
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
