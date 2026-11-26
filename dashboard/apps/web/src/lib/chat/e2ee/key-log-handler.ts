/**
 * `/api/e2ee/key-log`, as a plain function over a Request so tests drive what
 * the route serves. 404 while `chatE2eeEnabled()` is off.
 *
 * - `proofs`: the logged key of each account named, with its inclusion proof.
 *   With a `channelId`, only accounts that reach a conversation the caller
 *   reaches are answered - anybody else is left out, exactly as one without a
 *   key, the rule `account-keys` follows - so it tells nobody who exists or who
 *   set up encryption. Without one, only the caller's own account.
 * - `own`: every entry of the caller's own account, for its browsers to
 *   monitor.
 *
 * Both answer a fresh signed head and, given `since`, the consistency proof
 * from the size the browser last saw; given `logKey`, the log key it pinned,
 * every change of the log's key since, each proven a prefix of the head.
 */

import { z } from "zod";
import * as keyLog from "./key-log";
import { chatE2eeEnabled } from "./flag";
import { NextResponse } from "next/server";
import { backgroundUser } from "@/lib/session";
import { channelAccess } from "@/lib/chat/access";
import { rateLimit } from "@/lib/rate-limit-service";

const WINDOW_MS = 15 * 60 * 1000;
const PER_ACCOUNT = 600;
/** Accounts one `proofs` call names at most: a `member-account-keys` page. */
export const PROOF_PAGE = 100;

const since = z.number().int().min(0).max(2 ** 31).optional();
/** The log key the browser pinned: raw Ed25519, 32 bytes as 43 base64url characters. */
const logKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional();

export const keyLogBody = z.discriminatedUnion("op", [
    z.object({
        op: z.literal("proofs"),
        channelId: z.string().uuid().optional(),
        userIds: z.array(z.string().uuid()).min(1).max(PROOF_PAGE),
        since,
        logKey
    }).strict(),
    z.object({ op: z.literal("own"), since, logKey }).strict()
]);

export type KeyLogBody = z.infer<typeof keyLogBody>;

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function readBody(request: Request): Promise<unknown> {
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json(;|$)/i.test(type.trim())) return null;
    try {
        return await request.json();
    } catch {
        return null;
    }
}

const text = (value: Uint8Array) => Buffer.from(value).toString("base64url");

/** The answer as JSON: every byte string base64url. */
export function encodeAnswer(answer: keyLog.LogAnswer) {
    return {
        logKey: text(answer.logKey),
        head: {
            treeSize: answer.head.treeSize,
            timestamp: answer.head.timestamp,
            rootHash: text(answer.head.rootHash),
            signature: text(answer.head.signature)
        },
        consistency: answer.consistency?.map(text) ?? null,
        entries: answer.entries.map((e) => ({
            index: e.index,
            userId: e.userId,
            akVersion: e.akVersion,
            signPublicKey: text(e.signPublicKey),
            hpkePublicKey: text(e.hpkePublicKey),
            proof: e.proof.map(text)
        })),
        handovers: answer.handovers.map((h) => ({
            fromKey: text(h.fromKey),
            toKey: text(h.toKey),
            head: { treeSize: h.head.treeSize, timestamp: h.head.timestamp, rootHash: text(h.head.rootHash) },
            signature: h.signature ? text(h.signature) : null,
            consistency: h.consistency.map(text)
        }))
    };
}

export async function handleKeyLog(request: Request): Promise<Response> {
    if (!chatE2eeEnabled()) return json({ error: "Not found" }, 404);
    const user = await backgroundUser();
    // i18n-ignore: a status body no screen shows
    if (!user) return json({ error: "Unauthorized" }, 401);
    const parsed = keyLogBody.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid" }, 400);
    const limit = await rateLimit(`e2ee-key-log:${user.id}`, PER_ACCOUNT, WINDOW_MS);
    if (!limit.ok) return json({ error: "tooMany", retryAfterMs: limit.retryAfterMs }, 429);
    try {
        return json(encodeAnswer(await answer(user.id, parsed.data)));
    } catch (caught) {
        console.error("polaris: a key log answer failed:", caught);
        return json({ error: "unavailable" }, 503);
    }
}

async function answer(userId: string, body: KeyLogBody): Promise<keyLog.LogAnswer> {
    const seen: keyLog.Seen = {
        ...(body.since !== undefined ? { since: body.since } : {}),
        ...(body.logKey ? { logKey: new Uint8Array(Buffer.from(body.logKey, "base64url")) } : {})
    };
    if (body.op === "own") return keyLog.ownEntries(userId, seen);
    const distinct = [...new Set(body.userIds)];
    const { channelId } = body;
    if (!channelId) return keyLog.keyProofs(distinct.filter((id) => id === userId), seen);
    const callerReaches = await channelAccess({ id: userId }, channelId);
    const reach = callerReaches ? await Promise.all(distinct.map((id) => channelAccess({ id }, channelId))) : [];
    return keyLog.keyProofs(distinct.filter((_, i) => reach[i]), seen);
}
