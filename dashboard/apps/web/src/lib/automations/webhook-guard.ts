/**
 * The checks a call to a webhook trigger passes before it becomes an event:
 * method, address and country, client, rate, size, media type, and the
 * credential - in that order, so the cheap refusals happen before the body is
 * read and the signature, which needs the body, comes last.
 *
 * Shared by the public route and by "Send test", so a test goes through the
 * same checks a real caller does. Secrets are derived from the master key,
 * never stored, and compared in constant time.
 */

import { Prisma, prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { readCappedBody } from "@/lib/request-body";
import { geoAllowedForIp } from "@/lib/geo-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { countryForIp } from "@/lib/analytics-geoip";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFormBody, requestOrigin } from "./website-form";

/** A trigger's signing secret. Derived, never stored; "New secret" bumps the rotation. */
export function hookSecret(automationId: string, nodeId: string, rotation: number): string {
    const digest = createHmac("sha256", loadEnv().POLARIS_MASTER_KEY)
        .update(`automation-hook-secret:${automationId}:${nodeId}:${rotation}`)
        .digest("base64url");
    return `whsec_${digest}`;
}

export type HookRefusal = {
    ok: false;
    status: number;
    reason: core.WebhookRefusal;
    retryAfterSeconds?: number;
    /** The field a payload failed on: recorded for the owner, never answered. */
    detail?: string;
};

export type HookVerdict = { ok: true } | HookRefusal;

const OK: HookVerdict = { ok: true };

function refuse(status: number, reason: core.WebhookRefusal, retryAfterSeconds?: number): HookRefusal {
    return { ok: false, status, reason, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}

/** Constant-time equality of two strings of any length. */
export function sameSecret(given: string, expected: string): boolean {
    const a = createHmac("sha256", "compare").update(given).digest();
    const b = createHmac("sha256", "compare").update(expected).digest();
    return timingSafeEqual(a, b) && given.length === expected.length;
}

function hmacHex(algorithm: string, secret: string, text: Buffer): string {
    return createHmac(algorithm, secret).update(text).digest("hex");
}

/** The text a signature covers: the body, or `<timestamp>.<body>`. */
function signedText(timestamp: string | null, raw: Uint8Array): Buffer {
    const body = Buffer.from(raw);
    return timestamp === null ? body : Buffer.concat([Buffer.from(`${timestamp}.`), body]);
}

function fresh(timestamp: string, toleranceSeconds: number, nowMs: number): boolean {
    if (!/^\d{1,12}$/.test(timestamp)) return false;
    return Math.abs(nowMs / 1000 - Number(timestamp)) <= toleranceSeconds;
}

/** Whether the request carries the trigger's credential. */
export function verifyHookAuth(
    auth: core.WebhookAuth,
    secret: string,
    headers: Headers,
    raw: Uint8Array,
    nowMs: number = Date.now()
): HookVerdict {
    if (auth.mode === "none") return OK;
    if (auth.mode === "header") {
        const value = headers.get(auth.header)?.trim() ?? "";
        const given =
            auth.header === "authorization" ? (/^Bearer\s+(.+)$/i.exec(value)?.[1] ?? "") : value;
        return given && sameSecret(given, secret) ? OK : refuse(401, "auth");
    }
    if (auth.mode === "basic") {
        const value = headers.get("authorization")?.trim() ?? "";
        const encoded = /^Basic\s+(.+)$/i.exec(value)?.[1] ?? "";
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        return encoded && sameSecret(decoded, `${auth.username}:${secret}`)
            ? OK
            : refuse(401, "auth");
    }
    const value = headers.get(auth.header)?.trim() ?? "";
    if (!value) return refuse(401, "auth");
    if (auth.preset === "stripe") {
        const parts = new Map<string, string[]>();
        for (const piece of value.split(",")) {
            const [key, ...rest] = piece.trim().split("=");
            if (!key || rest.length === 0) continue;
            parts.set(key, [...(parts.get(key) ?? []), rest.join("=")]);
        }
        const timestamp = parts.get("t")?.[0];
        const signatures = parts.get("v1") ?? [];
        if (!timestamp || signatures.length === 0) return refuse(401, "auth");
        const expected = hmacHex("sha256", secret, signedText(timestamp, raw));
        if (!signatures.some((signature) => sameSecret(signature, expected)))
            return refuse(401, "auth");
        return fresh(timestamp, auth.toleranceSeconds, nowMs) ? OK : refuse(401, "signatureExpired");
    }
    const timestamp = auth.timestampHeader ? (headers.get(auth.timestampHeader)?.trim() ?? "") : null;
    if (timestamp === "") return refuse(401, "auth");
    const expected = `${auth.prefix}${hmacHex(auth.algorithm, secret, signedText(timestamp, raw))}`;
    if (!sameSecret(value, expected)) return refuse(401, "auth");
    if (timestamp !== null && !fresh(timestamp, auth.toleranceSeconds, nowMs))
        return refuse(401, "signatureExpired");
    return OK;
}

/** The headers a caller holding the secret sends: what "Send test" signs with. */
export function signHookHeaders(
    auth: core.WebhookAuth,
    secret: string,
    raw: Uint8Array,
    nowMs: number = Date.now()
): Record<string, string> {
    if (auth.mode === "none") return {};
    if (auth.mode === "header")
        return { [auth.header]: auth.header === "authorization" ? `Bearer ${secret}` : secret };
    if (auth.mode === "basic")
        return {
            authorization: `Basic ${Buffer.from(`${auth.username}:${secret}`).toString("base64")}`
        };
    const timestamp = String(Math.floor(nowMs / 1000));
    if (auth.preset === "stripe")
        return {
            [auth.header]: `t=${timestamp},v1=${hmacHex("sha256", secret, signedText(timestamp, raw))}`
        };
    const stamped = auth.timestampHeader ? timestamp : null;
    return {
        [auth.header]: `${auth.prefix}${hmacHex(auth.algorithm, secret, signedText(stamped, raw))}`,
        ...(auth.timestampHeader ? { [auth.timestampHeader]: timestamp } : {})
    };
}

/** Whether a Content-Type is on the list. `type/*` covers its subtypes; empty admits any. */
export function contentTypeAllowed(allowed: readonly string[], header: string | null): boolean {
    if (allowed.length === 0) return true;
    const type = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!type) return false;
    return allowed.some((rule) =>
        rule.endsWith("/*") ? type.startsWith(rule.slice(0, -1)) : type === rule
    );
}

/** The address and client rules, as a drop point or an API key applies them. */
export async function screenHookCaller(
    config: core.WebhookConfig,
    ip: string | undefined,
    userAgent: string | undefined
): Promise<HookVerdict> {
    if (config.deniedCidrs.length > 0 && ip && core.ipAllowed(ip, config.deniedCidrs))
        return refuse(403, "address");
    if (config.allowedCidrs.length > 0 && (!ip || !core.ipAllowed(ip, config.allowedCidrs)))
        return refuse(403, "address");
    if (!(await geoAllowedForIp(ip, config.allowedCountries, config.allowedContinents)))
        return refuse(403, "country");
    if (!core.userAgentAllowed(config, userAgent)) return refuse(403, "client");
    return OK;
}

/** The trigger's own ceilings: in total, and per address when set. */
export async function limitHook(
    config: core.WebhookConfig,
    hash: string,
    ip: string | undefined
): Promise<HookVerdict> {
    const { total } = config.rateLimit;
    // A form has no credential, so it always keeps a per-address ceiling.
    const perIp = config.rateLimit.perIp ?? (core.webhookIsForm(config) ? core.WEBSITE_FORM_PER_IP : null);
    const all = await rateLimit(`automation-hook:${hash}`, total.count, total.windowSeconds * 1000);
    if (!all.ok) return refuse(429, "rateLimited", Math.ceil(all.retryAfterMs / 1000));
    if (perIp && ip) {
        const one = await rateLimit(
            `automation-hook:${hash}:ip:${ip}`,
            perIp.count,
            perIp.windowSeconds * 1000
        );
        if (!one.ok) return refuse(429, "rateLimited", Math.ceil(one.retryAfterMs / 1000));
    }
    return OK;
}

const KEPT_HEADERS = ["content-type", "user-agent", "x-request-id", "x-github-event", "x-event-type"];

export type HookPayload = {
    kind: "webhook";
    method: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
};

export type HookInspection = (
    | { ok: true; payload: HookPayload; spam: boolean; fields?: Record<string, string> }
    | HookRefusal
) & {
    ip: string | undefined;
    userAgent: string | undefined;
};

/**
 * Everything after the trigger was found: what the route and "Send test" share.
 * `test` skips the caller rules and the rate limits, which describe callers
 * from outside, not the owner pressing a button.
 */
export async function inspectHook(input: {
    request: Request;
    config: core.WebhookConfig;
    secret: string;
    hash: string;
    test?: boolean;
}): Promise<HookInspection> {
    const { request, config } = input;
    const ip = core.originIp(request.headers);
    const userAgent = core.originUserAgent(request.headers);
    const seen = { ip, userAgent };
    const method = request.method.toUpperCase();
    if (!(core.webhookMethods(config) as string[]).includes(method))
        return { ...refuse(405, "method"), ...seen };
    const form = core.webhookIsForm(config) ? config.form : null;
    if (!input.test && form && !core.formOriginAllowed(form.allowedOrigins, requestOrigin(request.headers)))
        return { ...refuse(403, "origin"), ...seen };
    if (!input.test) {
        const caller = await screenHookCaller(config, ip, userAgent);
        if (!caller.ok) return { ...caller, ...seen };
        const limited = await limitHook(config, input.hash, ip);
        if (!limited.ok) return { ...limited, ...seen };
    }
    const most = Math.min(config.maxBodyKb * 1024, core.AUTOMATION_LIMITS.eventPayloadBytes);
    if (Number(request.headers.get("content-length") ?? "0") > most)
        return { ...refuse(413, "tooLarge"), ...seen };
    const bodiless = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const bytes = bodiless
        ? new Uint8Array(0)
        : await readCappedBody(request, most).catch(() => null);
    if (!bytes) return { ...refuse(413, "tooLarge"), ...seen };
    const types = form ? [...core.WEBSITE_FORM_TYPES] : config.contentTypes;
    if (bytes.length > 0 && !contentTypeAllowed(types, request.headers.get("content-type")))
        return { ...refuse(415, "contentType"), ...seen };
    if (form) return inspectForm(request, config, form, bytes, seen);
    const auth = verifyHookAuth(core.webhookAuth(config), input.secret, request.headers, bytes);
    if (!auth.ok) return { ...auth, ...seen };
    const raw = new TextDecoder().decode(bytes);
    let body: unknown = raw;
    if ((request.headers.get("content-type") ?? "").includes("json") && raw) {
        try {
            body = JSON.parse(raw);
        } catch {
            return { ...refuse(400, "invalidJson"), ...seen };
        }
    }
    const missing = config.requiredHeaders.find((name) => !request.headers.get(name));
    if (missing) return { ...refuse(400, "headers"), detail: missing, ...seen };
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const queryCheck = core.checkPayload(config.queryShape, query);
    if (!queryCheck.ok) return { ...refuse(422, "shape"), detail: `query.${queryCheck.path}`, ...seen };
    const bodyCheck = core.checkPayload(config.bodyShape, body);
    if (!bodyCheck.ok) return { ...refuse(422, "shape"), detail: `body.${bodyCheck.path}`, ...seen };
    body = bodyCheck.value;
    const headers: Record<string, string> = {};
    for (const name of [...KEPT_HEADERS, ...config.requiredHeaders]) {
        const value = request.headers.get(name);
        if (value) headers[name] = value.slice(0, 500);
    }
    return {
        ok: true,
        spam: false,
        payload: {
            kind: "webhook",
            method,
            query,
            headers,
            body
        },
        ...seen
    };
}

function keptHeaders(request: Request, config: core.WebhookConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const name of [...KEPT_HEADERS, ...config.requiredHeaders]) {
        const value = request.headers.get(name);
        if (value) headers[name] = value.slice(0, 500);
    }
    return headers;
}

/** A website form's post: its fields, the honeypot read, the same shape checks. */
async function inspectForm(
    request: Request,
    config: core.WebhookConfig,
    form: core.WebhookForm,
    bytes: Uint8Array,
    seen: { ip: string | undefined; userAgent: string | undefined }
): Promise<HookInspection> {
    const reading = await readFormBody(bytes, request.headers.get("content-type") ?? "", form.honeypotField);
    if (!reading.ok) return { ...refuse(reading.reason === "tooLarge" ? 413 : 400, reading.reason), ...seen };
    const missing = config.requiredHeaders.find((name) => !request.headers.get(name));
    if (missing) return { ...refuse(400, "headers"), detail: missing, ...seen };
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const queryCheck = core.checkPayload(config.queryShape, query);
    if (!queryCheck.ok) return { ...refuse(422, "shape"), detail: `query.${queryCheck.path}`, ...seen };
    const bodyCheck = core.checkPayload(config.bodyShape, reading.fields);
    if (!bodyCheck.ok && !reading.spam)
        return { ...refuse(422, "shape"), detail: `body.${bodyCheck.path}`, ...seen };
    return {
        ok: true,
        spam: reading.spam,
        fields: reading.fields,
        payload: {
            kind: "webhook",
            method: "POST",
            query,
            headers: keptHeaders(request, config),
            body: bodyCheck.ok ? bodyCheck.value : reading.fields
        },
        ...seen
    };
}

/** How many deliveries each trigger keeps. */
export const KEPT_DELIVERIES = 50;

/** How many form submissions each website form keeps, spam included. */
export const KEPT_SUBMISSIONS = 1000;

/** Write down one delivery and drop the ones past the newest 50. Never throws. */
export async function recordDelivery(entry: {
    automationId: string;
    nodeId: string;
    method: string;
    ip: string | undefined;
    userAgent: string | undefined;
    status: number;
    reason: core.WebhookRefusal | null;
    detail?: string;
    test?: boolean;
    /** A form post's fields, kept for its submissions list and export. */
    fields?: Record<string, string>;
    spam?: boolean;
}): Promise<void> {
    try {
        await prisma.automationHookDelivery.create({
            data: {
                automationId: entry.automationId,
                nodeId: entry.nodeId,
                method: entry.method.slice(0, 10),
                ip: entry.ip?.slice(0, 64) ?? null,
                country: countryForIp(entry.ip),
                userAgent: entry.userAgent?.slice(0, 200) ?? null,
                status: entry.status,
                reason: entry.reason,
                detail: entry.detail?.slice(0, 200) ?? null,
                test: entry.test ?? false,
                ...(entry.fields ? { fields: entry.fields } : {}),
                spam: entry.spam ?? false
            }
        });
        const submission = entry.fields !== undefined;
        const stale = await prisma.automationHookDelivery.findMany({
            where: {
                automationId: entry.automationId,
                nodeId: entry.nodeId,
                fields: submission ? { not: Prisma.DbNull } : { equals: Prisma.DbNull }
            },
            orderBy: { at: "desc" },
            skip: submission ? KEPT_SUBMISSIONS : KEPT_DELIVERIES,
            take: 100,
            select: { id: true }
        });
        if (stale.length > 0)
            await prisma.automationHookDelivery.deleteMany({
                where: { id: { in: stale.map((row) => row.id) } }
            });
    } catch (caught) {
        console.error("polaris: recording a webhook delivery failed:", caught);
    }
}

/** What each refusal answers a machine with. Never names an internal. */
export const REFUSAL_REPLY: Record<core.WebhookRefusal, string> = {
    method: "method not allowed",
    address: "forbidden",
    country: "forbidden",
    client: "forbidden",
    rateLimited: "rate limited",
    tooLarge: "too large",
    contentType: "unsupported media type",
    auth: "unauthorized",
    signatureExpired: "unauthorized",
    invalidJson: "invalid json",
    headers: "missing header",
    shape: "payload does not match",
    origin: "forbidden"
};

/** The answer to a refused call, with the headers its status calls for. */
export function refusalResponse(refusal: HookRefusal, config: core.WebhookConfig): Response {
    const headers: Record<string, string> = {};
    if (refusal.retryAfterSeconds) headers["retry-after"] = String(refusal.retryAfterSeconds);
    if (refusal.status === 405) headers.allow = core.webhookMethods(config).join(", ");
    const auth = core.webhookAuth(config);
    if (refusal.status === 401 && auth.mode === "basic")
        headers["www-authenticate"] = 'Basic realm="polaris"';
    // i18n-ignore: a reply to a machine caller, not read on screen
    return Response.json({ error: REFUSAL_REPLY[refusal.reason] }, { status: refusal.status, headers });
}
