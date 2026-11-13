/**
 * The publish endpoints' shared handling: who is posting, how much they may
 * post, and what is answered.
 *
 * Addresses (all `POST`, `PUT` also taken as ntfy does):
 * - `/api/alerts/<id>/<secret>` - ntfy: a text body plus headers, or JSON.
 * - `/api/alerts/<id>` - ntfy's JSON publish (`topic` is the secret) or
 *   Polaris' JSON with the secret as a bearer token.
 * - `/api/alerts/<id>/message` - Gotify, the secret as `?token=`, the
 *   `X-Gotify-Key` header or a bearer token.
 *
 * Every wrong id or secret answers the same 404 and counts against the caller's
 * address, so the secret space cannot be walked. Error bodies are short fixed
 * sentences; nothing internal is ever echoed.
 */

import type { AlertParse } from "./parse";
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/request-context";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { deliverAlert, topicFor, topicPostAllowed, type AlertSource } from "./topics";

/** Wrong addresses one caller may present per window. */
const MISSES = 30;
/** Posts one caller may make per window, across every topic. */
const PER_IP = 120;
const WINDOW_MS = 60_000;
/** The most a body may be: a 4,096-character message and its fields, with room. */
export const MAX_BODY_BYTES = 32 * 1024;

type Topic = NonNullable<Awaited<ReturnType<typeof topicFor>>>;

function limited(retryAfterMs: number): Response {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return NextResponse.json(
        // i18n-ignore read by a machine, not shown to a person
        { error: "Too many requests", http: 429 },
        { status: 429, headers: { "Retry-After": String(seconds) } }
    );
}

export function failure(status: number, error: string): Response {
    return NextResponse.json({ error, http: status }, { status });
}

/** The secret a request carries outside its path: bearer, basic password, Gotify's key or `?token=`. */
export function presentedSecret(request: Request): string | null {
    const header = request.headers.get("authorization")?.trim() ?? "";
    const [scheme, value] = header.split(/\s+/, 2);
    if (value && scheme?.toLowerCase() === "bearer") return value;
    if (value && scheme?.toLowerCase() === "basic") {
        try {
            const decoded = Buffer.from(value, "base64").toString("utf8");
            const colon = decoded.indexOf(":");
            if (colon >= 0) return decoded.slice(colon + 1);
        } catch {
            return null;
        }
    }
    const url = new URL(request.url);
    return request.headers.get("x-gotify-key") ?? url.searchParams.get("token") ?? null;
}

/** The topic, or the 404/429 to answer with. Also holds each caller to its own ceiling. */
export async function resolveTopic(id: string, secret: string | null): Promise<Topic | Response> {
    const ip = (await clientIp()) ?? "unknown";
    const caller = await rateLimit(`alert-post-ip:${ip}`, PER_IP, WINDOW_MS);
    if (!caller.ok) return limited(caller.retryAfterMs);
    const topic = secret ? await topicFor(id, secret) : null;
    if (topic) return topic;
    const misses = await rateLimit(`alert-miss:${ip}`, MISSES, WINDOW_MS);
    if (!misses.ok) return limited(misses.retryAfterMs);
    // i18n-ignore read by a machine, not shown to a person
    return failure(404, "Unknown topic");
}

/** The body as text, or null when it is larger than a publish may be. */
export async function bodyText(request: Request): Promise<string | null> {
    const bytes = await readCappedBody(request, MAX_BODY_BYTES).catch(() => null);
    return bytes ? new TextDecoder().decode(bytes) : null;
}

export function jsonOf(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** Deliver a parsed alert and answer as the shape's own server would. */
export async function publish(
    topic: Topic,
    parsed: AlertParse,
    source: AlertSource
): Promise<Response> {
    if (!parsed.ok) return failure(400, parsed.error);
    const allowed = await topicPostAllowed(topic.id);
    if (!allowed.ok) return limited(allowed.retryAfterMs);
    try {
        const result = await deliverAlert(topic, parsed.alert, source);
        const time = Math.floor(Date.now() / 1000);
        if (source === "gotify") {
            return NextResponse.json({
                id: result.id,
                appid: 0,
                title: parsed.alert.title,
                message: parsed.alert.message,
                priority: result.priority,
                date: new Date().toISOString()
            });
        }
        return NextResponse.json({
            id: result.id,
            time,
            event: "message",
            topic: topic.name,
            title: parsed.alert.title || undefined,
            message: parsed.alert.message,
            priority: result.priority,
            tags: parsed.alert.tags.length ? parsed.alert.tags : undefined,
            recipients: result.recipients
        });
    } catch (caught) {
        console.error("polaris: an alert could not be delivered:", caught);
        // i18n-ignore read by a machine, not shown to a person
        return failure(500, "The alert could not be delivered");
    }
}

export async function formOrJson(request: Request, text: string): Promise<unknown> {
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("application/x-www-form-urlencoded")) {
        return Object.fromEntries(new URLSearchParams(text));
    }
    return jsonOf(text);
}
