/**
 * Reading what a crashing program says about itself.
 *
 * Polaris speaks the ingest protocol Sentry's clients speak, because that is the
 * one every language already has a library for. An application deployed here
 * points its existing SDK at a Polaris address and reports to Polaris instead -
 * no agent to install, no format to learn, and nothing to change again if it ever
 * moves somewhere else. GlitchTip made the same choice for the same reason.
 *
 * Everything in this file is pure: parsing an envelope, reading an event out of
 * it, and deciding which existing issue it is another instance of. That last one
 * is the whole product - a thousand copies of one crash is a number, and a
 * thousand separate crashes is a screen nobody can read - and it is a judgement
 * call that has to be stable across releases, so it is decided here where it can
 * be stated and tested rather than inside a query.
 *
 * Nothing here trusts its input. Every field is written by a program that is, by
 * definition, having a bad day: strings are bounded, missing halves are normal,
 * and an event that cannot be read at all is dropped rather than stored as a row
 * of nulls nobody can act on.
 */

import { ipAllowed, isPrivateIp } from "./cidr.js";
import { userAgentAllowed } from "./user-agent.js";

/** How severe the reporter said it was. Anything unrecognised reads as "error",
 *  which is what an unlabelled crash is. */
export const TELEMETRY_LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;

export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

/** What an issue is doing now. `ignored` is not `resolved`: one says it was
 *  fixed, the other says it is known and not worth a badge. */
export const TELEMETRY_STATUSES = ["unresolved", "resolved", "ignored"] as const;

export type TelemetryStatus = (typeof TELEMETRY_STATUSES)[number];

/** Bounds. Every one of these is a header or a body field written by a client,
 *  so each is read up to a length and no further. */
const MAX_TITLE = 300;
const MAX_CULPRIT = 300;
const MAX_TAG = 200;
const MAX_TAGS = 50;
const MAX_FRAMES = 60;
const MAX_BREADCRUMBS = 40;

/** One line of a stack, as far as this cares about it. */
export interface StackFrame {
    readonly file: string;
    readonly function: string;
    readonly line: number | null;
    readonly column: number | null;
    /** Whether the reporter said this frame is the application's own code rather
     *  than a library's. It is what the grouping keys on, and what a stack trace
     *  shows expanded. */
    readonly inApp: boolean;
    readonly context: string | null;
}

export interface Breadcrumb {
    readonly at: string | null;
    readonly type: string;
    readonly category: string;
    readonly message: string;
    readonly level: TelemetryLevel;
}

/** An event, once it has been read out of whatever shape it arrived in. */
export interface CapturedEvent {
    /** The reporter's own id for it, which is what a client dedupes on. */
    readonly eventId: string | null;
    readonly level: TelemetryLevel;
    /** The exception's class - "TypeError". Empty for an event that is only a
     *  message, which is a legitimate thing to report. */
    readonly type: string;
    /** The exception's message, or the message itself. */
    readonly value: string;
    /** Where it happened, in one line, for a list somebody scans. */
    readonly culprit: string;
    readonly platform: string | null;
    readonly release: string | null;
    readonly environment: string | null;
    readonly serverName: string | null;
    readonly transaction: string | null;
    readonly url: string | null;
    readonly method: string | null;
    /** Who hit it, as a label and never as an identity: whatever the reporter
     *  chose to send. It is shown, never matched on. */
    readonly user: string | null;
    readonly tags: Readonly<Record<string, string>>;
    readonly frames: readonly StackFrame[];
    readonly breadcrumbs: readonly Breadcrumb[];
    readonly at: Date;
    /** What decides which issue this is another instance of. */
    readonly fingerprint: string;
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export interface EnvelopeItem {
    readonly type: string;
    readonly payload: unknown;
}

export interface Envelope {
    readonly header: Readonly<Record<string, unknown>>;
    readonly items: readonly EnvelopeItem[];
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function asString(value: unknown, max: number): string {
    if (typeof value === "string") return value.slice(0, max);
    if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
    return "";
}

function parseJson(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/**
 * An envelope, which is what every current client sends.
 *
 * It is newline-delimited JSON: one header, then pairs of item header and item
 * payload. The item header carries a `length`, and it is authoritative when it
 * is there - a payload is allowed to contain newlines, so splitting on them and
 * hoping is how a large event arrives truncated.
 *
 * An item that cannot be read is skipped rather than failing the envelope: a
 * client batches several kinds of thing into one request, and refusing all of
 * them because one is malformed loses the crash along with the noise.
 */
export function parseEnvelope(body: string): Envelope {
    const items: EnvelopeItem[] = [];
    const firstBreak = body.indexOf("\n");
    if (firstBreak === -1) return { header: asRecord(parseJson(body)), items };

    const header = asRecord(parseJson(body.slice(0, firstBreak)));
    let at = firstBreak + 1;

    while (at < body.length) {
        const headerEnd = body.indexOf("\n", at);
        if (headerEnd === -1) break;
        const itemHeader = asRecord(parseJson(body.slice(at, headerEnd)));
        at = headerEnd + 1;

        const stated = typeof itemHeader.length === "number" ? itemHeader.length : null;
        let payloadEnd: number;
        if (stated !== null && stated >= 0 && at + stated <= body.length) {
            payloadEnd = at + stated;
        } else {
            const nextBreak = body.indexOf("\n", at);
            payloadEnd = nextBreak === -1 ? body.length : nextBreak;
        }

        const raw = body.slice(at, payloadEnd);
        at = payloadEnd + 1;
        const type = asString(itemHeader.type, 40) || "event";
        const payload = parseJson(raw);
        if (payload !== null) items.push({ type, payload });
    }
    return { header, items };
}

/**
 * The public key a request identified itself with.
 *
 * Clients send it three ways and all three are in the wild: the `sentry_key`
 * query parameter, an `X-Sentry-Auth` header, and - on an envelope - a `dsn` in
 * the envelope header. Read all three so an SDK nobody chose does not have to be
 * configured specially.
 *
 * This names a project. It does not prove anything: a public key is public, it
 * ships inside the browser bundle of every web application that reports, and it
 * is a routing label rather than a credential. What stops it being abused is the
 * rate limit and the fact that it can only ever write into its own project.
 */
export function readIngestKey(input: {
    query?: string | null;
    header?: string | null;
    dsn?: string | null;
}): string | null {
    const fromQuery = input.query?.trim();
    if (fromQuery) return safeKey(fromQuery);

    const header = input.header ?? "";
    const stated = /sentry_key\s*=\s*([A-Za-z0-9]+)/i.exec(header)?.[1];
    if (stated) return safeKey(stated);

    return safeKey(dsnKey(input.dsn ?? ""));
}

/** The key half of a DSN, which is its user-info part. */
function dsnKey(dsn: string): string {
    const match = /^https?:\/\/([A-Za-z0-9]+)(?::[^@]*)?@/.exec(dsn.trim());
    return match?.[1] ?? "";
}

/** A key is hex-ish and bounded, so a lookup can never be handed a pattern. */
function safeKey(value: string): string | null {
    const trimmed = value.trim();
    return /^[A-Za-z0-9]{8,64}$/.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Reading an event
// ---------------------------------------------------------------------------

function levelOf(value: unknown): TelemetryLevel {
    const said = asString(value, 20).toLowerCase();
    if ((TELEMETRY_LEVELS as readonly string[]).includes(said)) return said as TelemetryLevel;
    // "critical" is what several clients send, and an unlabelled crash is an
    // error rather than a debug line.
    return said === "critical" ? "fatal" : "error";
}

/**
 * When it happened, as the reporter said.
 *
 * Sentry's timestamp is either seconds since the epoch or an ISO string, and a
 * client with a wrong clock is common enough that a date far from now is not
 * believed: an event stamped next year would sit at the top of every list
 * forever, and one stamped in 1970 would be pruned the moment it arrived.
 */
function timeOf(value: unknown, now: Date): Date {
    const parsed =
        typeof value === "number"
            ? new Date(value * 1000)
            : typeof value === "string"
              ? new Date(value)
              : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return now;
    const drift = Math.abs(parsed.getTime() - now.getTime());
    return drift > 24 * 60 * 60 * 1000 ? now : parsed;
}

function framesOf(stacktrace: unknown): StackFrame[] {
    const raw = asRecord(stacktrace).frames;
    if (!Array.isArray(raw)) return [];
    // Sentry sends a stack with the crashing frame LAST. Kept in that order,
    // because that is the order every SDK and every existing tool agrees on.
    return raw.slice(-MAX_FRAMES).map((entry) => {
        const frame = asRecord(entry);
        return {
            file: asString(frame.filename ?? frame.abs_path ?? frame.module, MAX_CULPRIT),
            function: asString(frame.function, MAX_TAG),
            line: typeof frame.lineno === "number" ? frame.lineno : null,
            column: typeof frame.colno === "number" ? frame.colno : null,
            inApp: frame.in_app === true,
            context: asString(frame.context_line, MAX_CULPRIT) || null
        };
    });
}

function breadcrumbsOf(value: unknown): Breadcrumb[] {
    const raw = Array.isArray(value) ? value : asRecord(value).values;
    if (!Array.isArray(raw)) return [];
    return raw.slice(-MAX_BREADCRUMBS).map((entry) => {
        const crumb = asRecord(entry);
        return {
            at: asString(crumb.timestamp, 40) || null,
            type: asString(crumb.type, 40) || "default",
            category: asString(crumb.category, MAX_TAG),
            message: asString(crumb.message, MAX_TITLE),
            level: levelOf(crumb.level)
        };
    });
}

function tagsOf(value: unknown): Record<string, string> {
    const tags: Record<string, string> = Object.create(null) as Record<string, string>;
    // Both shapes are in the wild: an object, and a list of pairs.
    const entries: [unknown, unknown][] = Array.isArray(value)
        ? value.map((pair) => {
              const row = Array.isArray(pair) ? pair : [];
              return [row[0], row[1]];
          })
        : Object.entries(asRecord(value));
    for (const [key, entry] of entries.slice(0, MAX_TAGS)) {
        const name = asString(key, 40);
        const said = asString(entry, MAX_TAG);
        if (name && said) tags[name] = said;
    }
    return tags;
}

/** The frame worth naming in a list: the application's own innermost one, and
 *  failing that the innermost one there is. A library's frame names the library,
 *  which is never where the bug is. */
function culpritOf(frames: readonly StackFrame[], fallback: string): string {
    const own = [...frames].reverse().find((frame) => frame.inApp) ?? frames[frames.length - 1];
    if (!own) return fallback.slice(0, MAX_CULPRIT);
    const where = own.line === null ? own.file : `${own.file}:${own.line}`;
    return (own.function ? `${own.function} (${where})` : where).slice(0, MAX_CULPRIT);
}

/**
 * Read an event out of whatever the client sent.
 *
 * Returns null for a payload that names no failure at all - a transaction, a
 * session, a client report. Those are legitimate items on an envelope and the
 * caller answers them with a 200; they are simply not what this stores.
 */
export function readEvent(payload: unknown, now: Date): CapturedEvent | null {
    const event = asRecord(payload);

    const exceptions = asRecord(event.exception).values;
    const thrown = Array.isArray(exceptions) ? asRecord(exceptions[exceptions.length - 1]) : {};
    const message = asRecord(event.message);

    const type = asString(thrown.type, MAX_TITLE);
    const value =
        asString(thrown.value, MAX_TITLE) ||
        asString(event.message, MAX_TITLE) ||
        asString(message.formatted ?? message.message, MAX_TITLE) ||
        asString(asRecord(asRecord(event.logentry).message).formatted, MAX_TITLE) ||
        asString(asRecord(event.logentry).message, MAX_TITLE);

    // Nothing to show and nothing to group: not an event, whatever it is.
    if (!type && !value) return null;

    const frames = framesOf(thrown.stacktrace ?? asRecord(event.stacktrace));
    const request = asRecord(event.request);
    const user = asRecord(event.user);

    const read = {
        eventId: asString(event.event_id, 64) || null,
        level: levelOf(event.level),
        type,
        value,
        culprit: culpritOf(frames, asString(event.transaction, MAX_CULPRIT) || asString(event.culprit, MAX_CULPRIT)),
        platform: asString(event.platform, 40) || null,
        release: asString(event.release, MAX_TAG) || null,
        environment: asString(event.environment, MAX_TAG) || null,
        serverName: asString(event.server_name, MAX_TAG) || null,
        transaction: asString(event.transaction, MAX_CULPRIT) || null,
        url: asString(request.url, 2000) || null,
        method: asString(request.method, 10).toUpperCase() || null,
        // A label, in the order of how much it says about a person, and never an
        // address on its own: an IP with nothing beside it identifies somebody
        // who never agreed to be identified here.
        user: asString(user.username ?? user.email ?? user.id, MAX_TAG) || null,
        tags: tagsOf(event.tags),
        frames,
        breadcrumbs: breadcrumbsOf(event.breadcrumbs),
        at: timeOf(event.timestamp, now)
    };

    return { ...read, fingerprint: fingerprintOf(read, event.fingerprint) };
}

// ---------------------------------------------------------------------------
// Which issue this is
// ---------------------------------------------------------------------------

/**
 * A stable hash of a string. Not a cryptographic one and not meant to be: what
 * this identifies is "the same crash as last time", and the only property that
 * matters is that the same input gives the same answer in every process and
 * every release. Two rounds of FNV-1a with different offsets, so the answer is
 * wide enough that two unrelated crashes do not collide in a real project.
 */
function stableHash(value: string): string {
    let low = 0x811c9dc5;
    let high = 0x01000193;
    for (let at = 0; at < value.length; at += 1) {
        const code = value.charCodeAt(at);
        low = Math.imul(low ^ code, 0x01000193) >>> 0;
        high = Math.imul(high ^ code, 0x85ebca6b) >>> 0;
    }
    return `${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
}

/** Digits, hex ids, uuids and addresses inside a message, which are what make
 *  one crash look like a thousand. Replaced rather than dropped so what is left
 *  still reads as the sentence it was. */
const VARIABLE = [
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
    [/\b0x[0-9a-f]+\b/gi, "<addr>"],
    [/\b[0-9a-f]{16,}\b/gi, "<hash>"],
    [/\b\d+\b/g, "<n>"]
] as const;

/** What a message says, with the parts that differ every time taken out. */
export function generalize(message: string): string {
    let said = message;
    for (const [pattern, replacement] of VARIABLE) said = said.replace(pattern, replacement);
    return said.trim();
}

/**
 * Which issue an event belongs to.
 *
 * The rule, in order:
 *
 * 1. **What the reporter said.** An SDK can send its own `fingerprint`, and a
 *    team that has written one knows something about their code that no
 *    heuristic here does. `{{ default }}` inside it means "and also the usual",
 *    which is how Sentry spells it, so it is dropped and the rest is added to
 *    what would have been computed anyway.
 * 2. **The stack.** The exception's class plus the application's own frames, by
 *    file and function and never by line: a line number moves every time
 *    somebody adds an import above it, and grouping on it would file the same
 *    bug again after every commit. Library frames are left out for the same
 *    reason as the culprit - they are where it surfaced, not where it is.
 * 3. **The message**, generalized, for an event with no stack at all. Without
 *    the generalization, "user 91 not found" and "user 92 not found" are two
 *    issues, and a busy day is a thousand.
 */
export function fingerprintOf(
    event: Pick<CapturedEvent, "type" | "value" | "frames" | "culprit">,
    stated?: unknown
): string {
    const parts: string[] = [];

    const said = Array.isArray(stated)
        ? stated.map((entry) => asString(entry, MAX_TAG)).filter(Boolean)
        : [];
    const wantsDefault = said.length === 0 || said.some((entry) => entry.includes("{{ default }}"));
    for (const entry of said) {
        if (!entry.includes("{{ default }}")) parts.push(entry);
    }

    if (wantsDefault) {
        parts.push(event.type || "message");
        const own = event.frames.filter((frame) => frame.inApp);
        const shape = (own.length > 0 ? own : event.frames).map(
            (frame) => `${frame.file}:${frame.function}`
        );
        if (shape.length > 0) parts.push(...shape);
        else parts.push(generalize(event.value));
    }

    return stableHash(parts.join("\n"));
}

/** What an issue is called in a list: the class and the first line of what it
 *  said, which together are what somebody recognises it by. */
export function titleOf(event: Pick<CapturedEvent, "type" | "value">): string {
    const line = event.value.split("\n")[0]?.trim() ?? "";
    if (!event.type) return line.slice(0, MAX_TITLE) || "Unknown error";
    return (line ? `${event.type}: ${line}` : event.type).slice(0, MAX_TITLE);
}

// ---------------------------------------------------------------------------
// Who may report
// ---------------------------------------------------------------------------

/**
 * Where a project accepts reports from.
 *
 * The key in a DSN names a project and proves nothing - it ships inside the
 * browser bundle of every web application that reports, and anybody who has seen
 * one can write into that project forever. That is how the protocol works and it
 * is not going to change, so the answer is to narrow who gets to try.
 *
 * - `internal`: the machines on this network, which is where an application
 *   deployed by Polaris reports from, plus anything in the address list. The
 *   default, because it costs nothing to set up and it is already the right
 *   answer for the reporters Polaris deploys itself.
 * - `listed`: the address list and nothing else. For a reporter that lives
 *   somewhere known - one server, one CI runner.
 * - `anywhere`: no address check at all. What a browser client needs, because its
 *   reports come from the addresses of the people using it; the user-agent rules
 *   and the key still apply.
 */
export const TELEMETRY_REPORTERS = ["internal", "listed", "anywhere"] as const;

export type TelemetryReporters = (typeof TELEMETRY_REPORTERS)[number];

/** Anything unrecognised reads as the strictest of the three rather than the
 *  loosest: a column that has been edited by hand must not widen a project. */
export function readReporters(value: unknown): TelemetryReporters {
    const said = typeof value === "string" ? value.trim() : "";
    return (TELEMETRY_REPORTERS as readonly string[]).includes(said)
        ? (said as TelemetryReporters)
        : "listed";
}

/** What a project will admit. */
export interface ReporterRules {
    readonly reporters: TelemetryReporters;
    /** Addresses and ranges admitted whatever the policy says. */
    readonly allowedCidrs: readonly string[];
    readonly allowedUserAgents: readonly string[];
    readonly deniedUserAgents: readonly string[];
    /** Whether a report must also carry the project's own key. */
    readonly requireSecret: boolean;
}

/** What one request looks like to the rules. `secret` is what it presented, not
 *  whether it was right - comparing is the caller's job, because that is where
 *  the stored hash is. */
export interface ReporterRequest {
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly secretOk: boolean;
}

/** Which check turned a report away, or null when none did. The word is shown on
 *  the project, so it says what to change rather than that something is wrong. */
export type IngestRefusal = "address" | "client" | "secret" | null;

/**
 * Whether a report is admitted, and if not, by which rule.
 *
 * Checked in the order somebody would fix them: where it came from, what sent
 * it, then what it carried. None of the three is a proof of identity on its own -
 * an address can be spoofed on a network that lets it and a header is written by
 * whoever makes the request - which is why these narrow a public key rather than
 * standing in for a credential. The key is the one that does not narrow: it is a
 * secret, and a request without it is refused however plausible it looks.
 */
export function reporterRefusal(rules: ReporterRules, request: ReporterRequest): IngestRefusal {
    if (rules.reporters !== "anywhere") {
        const from = request.ip?.trim() ?? "";
        // No address at all is refused rather than admitted: a policy that says
        // "only from here" must not be satisfied by a request that declines to
        // say where it is from.
        if (!from) return "address";
        const listed = ipAllowed(from, rules.allowedCidrs);
        const named = rules.allowedCidrs.length > 0 && listed;
        const inside = rules.reporters === "internal" && isPrivateIp(from);
        if (!named && !inside) return "address";
    }

    if (
        !userAgentAllowed(
            {
                allowedUserAgents: [...rules.allowedUserAgents],
                deniedUserAgents: [...rules.deniedUserAgents]
            },
            request.userAgent
        )
    ) {
        return "client";
    }

    if (rules.requireSecret && !request.secretOk) return "secret";
    return null;
}

/**
 * The key a report carried, wherever it put it.
 *
 * Not part of the Sentry protocol - that has no second credential any current
 * client sends - so this reads the places a client can actually be made to put
 * one: a header of our own, an ordinary bearer token, and `sentry_secret` in the
 * auth header, which is the deprecated half of the old DSN format and is still
 * sent by some clients that will never be updated.
 *
 * A JavaScript client sets the first through its transport headers, and anything
 * posting the envelope itself sets whichever it likes.
 */
export function readIngestSecret(input: {
    header?: string | null;
    authorization?: string | null;
    sentryAuth?: string | null;
}): string | null {
    const own = input.header?.trim();
    if (own) return boundedSecret(own);

    const bearer = /^Bearer\s+(\S+)$/i.exec(input.authorization?.trim() ?? "")?.[1];
    if (bearer) return boundedSecret(bearer);

    const legacy = /sentry_secret\s*=\s*([A-Za-z0-9]+)/i.exec(input.sentryAuth ?? "")?.[1];
    return legacy ? boundedSecret(legacy) : null;
}

/** Bounded before it is compared, so a header cannot be used to make hashing
 *  expensive. */
function boundedSecret(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length >= 16 && trimmed.length <= 200 ? trimmed : null;
}
