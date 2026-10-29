/**
 * Whether an address is really a Polaris, asked before it is added.
 *
 * Until this, any host that answered at all was taken: `test.com` went on the
 * list as a server and only failed later, with nothing to say why. Now the
 * address is asked who it is while it is being typed, and the answer has to
 * have the exact shape a Polaris gives - an HTML page, a parked domain, a
 * captive portal or a redirect to somewhere else are all "not Polaris".
 *
 * Three questions, newest first, so an install that predates the newer ones is
 * still recognized by the older signal it already serves:
 *
 * 1. `GET /api/polaris/identity` - `{ product: "polaris", protocol }`.
 * 2. `GET /api/instance` - the instance id and key, served since the local
 *    network fallback.
 * 3. `GET /api/health` - `{ status: "ok" }`, served by every install.
 *
 * Each step moves on only when the one before answered 404 (or 429/503, which
 * is a Polaris that is busy rather than something else); any other answer is
 * final. Nothing of the person's is sent: no cookies, no referrer, no token.
 * One budget of {@link PROBE_TIMEOUT_MS} covers all three, and a body is read
 * no further than {@link MAX_BODY_BYTES}.
 *
 * Used by the popup to answer as the field is typed in, and by the worker to
 * decide, because a caller is never where a decision is allowed to be final.
 */

import { z } from "zod";
import { readInstance } from "@polaris/core/instance-fallback";

export const IDENTITY_PATH = "/api/polaris/identity";
const INSTANCE_PATH = "/api/instance";
const HEALTH_PATH = "/api/health";

/** The whole probe, all steps together. */
export const PROBE_TIMEOUT_MS = 5_000;
/** The most of a body that is read. Every real answer is under 1 KiB. */
export const MAX_BODY_BYTES = 4_096;
/** How long an answer is reused, so retyping an address does not ask again. */
export const CACHE_MS = 30_000;
/** How long "could not reach it" is reused: shorter, it is often a blip. */
const UNREACHABLE_CACHE_MS = 5_000;
const CACHE_ENTRIES = 50;

/** What `/api/polaris/identity` answers. Extra fields are allowed for later
 *  protocols; the marker and the protocol are not optional. */
export const identitySchema = z.object({
    product: z.literal("polaris"),
    protocol: z.number().int().min(1).max(1_000),
    name: z.string().trim().min(1).max(80).optional(),
    version: z.string().trim().min(1).max(40).optional()
});

const healthOkSchema = z.object({ status: z.literal("ok") });
const healthDownSchema = z.object({ status: z.literal("error") });

export type ServerVerdict =
    | {
          readonly kind: "polaris";
          readonly name: string | null;
          readonly version: string | null;
          /** Recognized by an older signal: an install that predates the identity route. */
          readonly legacy: boolean;
      }
    /** A Polaris that is up but cannot reach its database yet. */
    | { readonly kind: "starting" }
    /** Something answered, and it is not a Polaris. */
    | { readonly kind: "not-polaris" }
    /** It sends visitors to another address. */
    | { readonly kind: "redirects" }
    /** Nothing answered in time, or the name does not resolve. */
    | { readonly kind: "unreachable" }
    /**
     * It answered as a web server, but the last, older check could not be read
     * without the browser's permission for the host (Firefox reads other hosts
     * only through CORS, and `/api/health` sends none). The worker decides once
     * the permission is there.
     */
    | { readonly kind: "unconfirmed" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type Reply =
    | { readonly kind: "answer"; readonly status: number; readonly body: unknown }
    | { readonly kind: "redirect" };

/** The body as JSON when it is JSON and small, otherwise null. Never reads past the cap. */
export async function readSmallJson(response: Response, cap = MAX_BODY_BYTES): Promise<unknown> {
    const type = response.headers.get("content-type") ?? "";
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (!/\bjson\b/i.test(type) || declared > cap) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

async function ask(fetchImpl: FetchLike, origin: string, path: string, signal: AbortSignal): Promise<Reply> {
    const response = await fetchImpl(`${origin}${path}`, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "application/json" },
        signal
    });
    const landed = response.url ? new URL(response.url).origin : origin;
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) || landed !== origin) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "redirect" };
    }
    return { kind: "answer", status: response.status, body: await readSmallJson(response) };
}

/** Whether a status means "ask the older signal": not there yet, or busy. */
function moveOn(status: number): boolean {
    return status === 404 || status === 429 || status === 503;
}

/**
 * Ask `origin` whether it is a Polaris. Throws only when `signal` was aborted by
 * the caller (the input changed); every other failure is a verdict.
 */
export async function probeServer(
    origin: string,
    signal?: AbortSignal,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    timeoutMs = PROBE_TIMEOUT_MS
): Promise<ServerVerdict> {
    const budget = AbortSignal.timeout(timeoutMs);
    const both = signal ? AbortSignal.any([signal, budget]) : budget;
    let answered = false;
    try {
        const identity = await ask(fetchImpl, origin, IDENTITY_PATH, both);
        if (identity.kind === "redirect") return { kind: "redirects" };
        answered = true;
        if (identity.status === 200) {
            const parsed = identitySchema.safeParse(identity.body);
            if (!parsed.success) return { kind: "not-polaris" };
            return {
                kind: "polaris",
                name: parsed.data.name ?? null,
                version: parsed.data.version ?? null,
                legacy: false
            };
        }
        if (!moveOn(identity.status)) return { kind: "not-polaris" };

        const instance = await ask(fetchImpl, origin, INSTANCE_PATH, both);
        if (instance.kind === "redirect") return { kind: "redirects" };
        if (instance.status === 200) {
            return readInstance(instance.body)
                ? { kind: "polaris", name: null, version: null, legacy: true }
                : { kind: "not-polaris" };
        }
        if (!moveOn(instance.status)) return { kind: "not-polaris" };

        const health = await ask(fetchImpl, origin, HEALTH_PATH, both);
        if (health.kind === "redirect") return { kind: "redirects" };
        if (health.status === 200 && healthOkSchema.safeParse(health.body).success) {
            return { kind: "polaris", name: null, version: null, legacy: true };
        }
        if (health.status === 503 && healthDownSchema.safeParse(health.body).success) {
            return { kind: "starting" };
        }
        return { kind: "not-polaris" };
    } catch (caught) {
        if (signal?.aborted) throw caught;
        if (budget.aborted) return { kind: "unreachable" };
        // The host answered the first question, so it is up: a later one that
        // cannot be read is the browser holding it back, not the network.
        return answered ? { kind: "unconfirmed" } : { kind: "unreachable" };
    }
}

/**
 * {@link probeServer} with a short memory per address, so typing an address,
 * deleting a letter and typing it again asks once.
 */
export function createServerCheck(fetchImpl?: FetchLike, now: () => number = Date.now) {
    const memory = new Map<string, { readonly verdict: ServerVerdict; readonly until: number }>();

    const peek = (origin: string): ServerVerdict | null => {
        const held = memory.get(origin);
        if (!held) return null;
        if (held.until > now()) return held.verdict;
        memory.delete(origin);
        return null;
    };

    const check = async (origin: string, signal?: AbortSignal): Promise<ServerVerdict> => {
        const held = peek(origin);
        if (held) return held;
        const verdict = await probeServer(origin, signal, fetchImpl);
        const keep = verdict.kind === "unreachable" || verdict.kind === "unconfirmed" ? UNREACHABLE_CACHE_MS : CACHE_MS;
        if (memory.size >= CACHE_ENTRIES) memory.delete(memory.keys().next().value!);
        memory.set(origin, { verdict, until: now() + keep });
        return verdict;
    };

    return { peek, check };
}

export type ServerCheck = ReturnType<typeof createServerCheck>;
