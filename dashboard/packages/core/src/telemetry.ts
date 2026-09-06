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
/** The code around a frame. Five lines either side is what fits on a screen
 *  without scrolling and what every tool that shows one has settled on. */
const MAX_SNIPPET = 5;
const MAX_CONTEXTS = 16;
const MAX_CONTEXT_FIELDS = 32;
const MAX_HEADERS = 60;
const MAX_CRUMB_DATA = 12;
/** A request body, which is the one field here written by a person rather than
 *  by a client library, and the one that can be a megabyte. */
const MAX_BODY = 4000;
const MAX_VALUE = 1000;

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
    /** The line that threw. */
    readonly context: string | null;
    /** The lines above and below it, in order. A stack frame says where; these
     *  are what says what, and they are the difference between a file and line
     *  somebody has to go and open and an answer on the screen. Sent by every
     *  SDK that can read its own source, and dropped on the floor here until
     *  there was somewhere to show them. */
    readonly pre: readonly string[];
    readonly post: readonly string[];
}

/** One header, and whether it is the kind that should not be read over
 *  somebody's shoulder. */
export interface HeaderField {
    readonly name: string;
    readonly value: string;
    /** Marked here rather than blanked here. A credential in a request is often
     *  the reason the request failed - the wrong key, the expired token - so
     *  removing it removes the answer. The screen keeps it covered until
     *  somebody asks for it; see `headerIsSecret`. */
    readonly secret: boolean;
}

/** What the failing request was, as far as the reporter described it. */
export interface RequestFacts {
    readonly url: string | null;
    readonly method: string | null;
    readonly query: readonly HeaderField[];
    readonly headers: readonly HeaderField[];
    /** The body as text. JSON is kept as it arrived except for values under a
     *  key that names a secret, which are covered like a header. */
    readonly body: string | null;
}

/** A named group of facts about where the program was running - the runtime,
 *  the operating system, the machine. Ordered rather than a bare object so the
 *  screen draws them the same way twice. */
export interface ContextGroup {
    readonly name: string;
    readonly fields: readonly { readonly key: string; readonly value: string }[];
}

/** Which client library reported, which is the first question when an event
 *  arrives in a shape nothing else sends. */
export interface SdkFacts {
    readonly name: string;
    readonly version: string;
}

export interface Breadcrumb {
    readonly at: string | null;
    readonly type: string;
    readonly category: string;
    readonly message: string;
    readonly level: TelemetryLevel;
    /** What the crumb carried - the URL and status of a request, the arguments
     *  of a log line. Most crumbs are only legible with it: an `http` crumb with
     *  its data removed is the word "http". */
    readonly data: readonly { readonly key: string; readonly value: string }[];
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
    /** Where the program was running: its runtime and version, the operating
     *  system, the machine's memory and processors. Every client sends this and
     *  it is most of what makes one report actionable - "it only happens on the
     *  old node" is a sentence nobody can say without it. */
    readonly contexts: readonly ContextGroup[];
    /** The request that was in flight, when the report came from something
     *  serving one. */
    readonly request: RequestFacts | null;
    readonly sdk: SdkFacts | null;
    /** The address the report came from. Kept because the question "which
     *  machine" is the second one asked about anything running in more than one
     *  place, and `server_name` is often a container id that answers it badly. */
    readonly ip: string | null;
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
            context: asString(frame.context_line, MAX_CULPRIT) || null,
            pre: sourceLines(frame.pre_context).slice(-MAX_SNIPPET),
            post: sourceLines(frame.post_context).slice(0, MAX_SNIPPET)
        };
    });
}

/** The lines of source around a frame, as strings and nothing else. A client is
 *  free to send nulls in here for lines it could not read. */
function sourceLines(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((line) => asString(line, MAX_CULPRIT));
}

/**
 * Whether a header, a query parameter or a field name is carrying a credential.
 *
 * Matched as a substring, and that asymmetry is deliberate: covering something
 * harmless costs a click, and failing to cover a bearer token puts a live
 * credential on a screen, in a screenshot, and in whatever the screenshot is
 * pasted into. There is no header worth reading at a glance badly enough to
 * justify the other mistake.
 *
 * Pure and exported so the ingest, the screen and the tests all decide this the
 * same way, once.
 */
export function headerIsSecret(name: string): boolean {
    const lower = name.trim().toLowerCase();
    return SECRET_WORDS.some((word) => lower.includes(word));
}

const SECRET_WORDS = [
    "auth",
    "cookie",
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "signature",
    "session",
    "api-key",
    "api_key",
    "apikey"
] as const;

/** A list of name/value pairs, bounded, with the secrets among them marked. */
function fieldsOf(value: unknown, limit: number): HeaderField[] {
    const entries: [unknown, unknown][] = Array.isArray(value)
        ? value.map((pair) => {
              const row = Array.isArray(pair) ? pair : [];
              return [row[0], row[1]];
          })
        : Object.entries(asRecord(value));
    const fields: HeaderField[] = [];
    for (const [key, entry] of entries.slice(0, limit)) {
        const name = asString(key, 80);
        if (!name) continue;
        fields.push({
            name,
            value: asString(entry, MAX_VALUE),
            secret: headerIsSecret(name)
        });
    }
    return fields;
}

/** The query string, as its parameters. Sentry sends it either already split or
 *  as the raw string, and both are in the wild. */
function queryOf(value: unknown): HeaderField[] {
    if (typeof value !== "string") return fieldsOf(value, MAX_HEADERS);
    const raw = value.startsWith("?") ? value.slice(1) : value;
    if (!raw) return [];
    return raw
        .split("&")
        .slice(0, MAX_HEADERS)
        .map((pair) => {
            const at = pair.indexOf("=");
            const name = decodeSafely(at === -1 ? pair : pair.slice(0, at));
            const said = at === -1 ? "" : decodeSafely(pair.slice(at + 1));
            return { name, value: said, secret: headerIsSecret(name) };
        })
        .filter((field) => field.name !== "");
}

/** Percent-decoding that cannot throw on a malformed escape, which a crashing
 *  program is entitled to send. */
function decodeSafely(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, " ")).slice(0, MAX_VALUE);
    } catch {
        return value.slice(0, MAX_VALUE);
    }
}

/**
 * The body, as text.
 *
 * A JSON body is re-serialized with the values of secret-looking keys replaced,
 * because a login that failed reports the password that failed with it. Anything
 * that is not JSON is kept as it came and bounded - guessing at the structure of
 * a form encoding or a protobuf would be a way to mangle it, not to protect it.
 */
function bodyOf(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.slice(0, MAX_BODY) || null;
    try {
        return JSON.stringify(coverSecrets(value), null, 2).slice(0, MAX_BODY);
    } catch {
        return null;
    }
}

/** The same value with anything under a secret-looking key replaced. Walks
 *  nested objects, because a credential is as often one level down. */
function coverSecrets(value: unknown, depth = 0): unknown {
    if (depth > 6) return value;
    if (Array.isArray(value)) return value.map((entry) => coverSecrets(entry, depth + 1));
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = headerIsSecret(key) ? COVERED : coverSecrets(entry, depth + 1);
    }
    return out;
}

/** What stands in for a value that was covered inside a body. Written out
 *  rather than blanked, so a reader can tell "it was there and is hidden" from
 *  "it was never sent" - which are different bugs. */
const COVERED = "[hidden]";

/**
 * Where the program was running.
 *
 * Sentry's `contexts` is an open map of open maps, and the whole value of it is
 * that a client can put anything in. So nothing here is interpreted: each group
 * is flattened to its own scalar fields, in the order the client wrote them,
 * with the well-known ones first because those are the ones read every time.
 */
function contextsOf(value: unknown): ContextGroup[] {
    const groups: ContextGroup[] = [];
    for (const [name, entry] of Object.entries(asRecord(value)).slice(0, MAX_CONTEXTS)) {
        const label = asString(name, 60);
        if (!label) continue;
        const fields: { key: string; value: string }[] = [];
        for (const [key, said] of Object.entries(asRecord(entry)).slice(0, MAX_CONTEXT_FIELDS)) {
            // "type" is the client repeating the group's own name back, which is
            // a row that says nothing on every single group.
            if (key === "type") continue;
            const printed =
                said !== null && typeof said === "object" ? safeJson(said) : asString(said, MAX_VALUE);
            if (printed) fields.push({ key: asString(key, 60), value: printed });
        }
        if (fields.length > 0) groups.push({ name: label, fields });
    }
    return groups.sort((left, right) => contextRank(left.name) - contextRank(right.name));
}

/** The order the groups are read in. Everything unlisted keeps its own order
 *  after the known ones rather than being sorted into them. */
const CONTEXT_ORDER = ["runtime", "os", "browser", "device", "app", "trace", "culture"];

function contextRank(name: string): number {
    const at = CONTEXT_ORDER.indexOf(name.toLowerCase());
    return at === -1 ? CONTEXT_ORDER.length : at;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value).slice(0, MAX_VALUE);
    } catch {
        return "";
    }
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
            level: levelOf(crumb.level),
            data: Object.entries(asRecord(crumb.data))
                .slice(0, MAX_CRUMB_DATA)
                .map(([key, said]) => ({
                    key: asString(key, 60),
                    value:
                        said !== null && typeof said === "object"
                            ? safeJson(said)
                            : asString(said, MAX_VALUE)
                }))
                .filter((field) => field.key !== "" && field.value !== "")
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

/** The request, or null when the reporter described none - which is most of
 *  what a background job or a CLI sends. */
function requestOf(request: Record<string, unknown>): RequestFacts | null {
    const url = asString(request.url, 2000) || null;
    const method = asString(request.method, 10).toUpperCase() || null;
    const headers = fieldsOf(request.headers, MAX_HEADERS);
    const query = queryOf(request.query_string);
    const body = bodyOf(request.data);
    // Cookies arrive in their own field as often as in a header, and they are a
    // credential wherever they arrive.
    const cookies = typeof request.cookies === "string" ? request.cookies : "";
    const all = cookies
        ? [...headers, { name: "cookie", value: cookies.slice(0, MAX_VALUE), secret: true }]
        : headers;
    if (!url && !method && all.length === 0 && query.length === 0 && !body) return null;
    return { url, method, query, headers: all, body };
}

function sdkOf(value: unknown): SdkFacts | null {
    const sdk = asRecord(value);
    const name = asString(sdk.name, MAX_TAG);
    if (!name) return null;
    return { name, version: asString(sdk.version, 40) };
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
        contexts: contextsOf(event.contexts),
        request: requestOf(request),
        sdk: sdkOf(event.sdk),
        // `user.ip_address` is where every SDK puts it; a server-side client
        // that knows the caller's address puts that one in the request's env
        // instead, which is the same question with a different answer.
        ip:
            asString(user.ip_address, 60) ||
            asString(asRecord(request.env).REMOTE_ADDR, 60) ||
            null,
        at: timeOf(event.timestamp, now)
    };

    return { ...read, fingerprint: fingerprintOf(read, event.fingerprint) };
}

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

/**
 * What was kept beside an event's own columns.
 *
 * The mirror of what `captureEvent` writes into its JSON column, and the reason
 * that column can stay schemaless: the shape of a crash report grows every time
 * a client starts sending something new, so a row is read against what the
 * screen needs today rather than against what was true the day it was written.
 */
export interface StoredEventFacts {
    readonly frames: readonly StackFrame[];
    readonly breadcrumbs: readonly Breadcrumb[];
    readonly tags: Readonly<Record<string, string>>;
    readonly contexts: readonly ContextGroup[];
    readonly request: RequestFacts | null;
    readonly sdk: SdkFacts | null;
    readonly ip: string | null;
    readonly platform: string | null;
}

/**
 * Read a stored event's detail column.
 *
 * Total, in the sense that matters: every list is a list and every group has its
 * fields, whatever the column actually holds - an older shape, a truncated
 * write, or something that is not JSON at all. A stored row is not input that
 * can be validated at the door and then trusted, because the door it came
 * through was a previous release, and a screen that reads a list that release
 * did not write is a screen that is blank for everything reported before an
 * update.
 */
export function readStoredEvent(detail: string): StoredEventFacts {
    const stored = asRecord(parseJson(detail));
    return {
        frames: storedFrames(stored.frames),
        breadcrumbs: storedBreadcrumbs(stored.breadcrumbs),
        tags: tagsOf(stored.tags),
        contexts: storedContexts(stored.contexts),
        request: storedRequest(stored.request),
        sdk: sdkOf(stored.sdk),
        ip: asString(stored.ip, 60) || null,
        platform: asString(stored.platform, 40) || null
    };
}

function storedFrames(value: unknown): StackFrame[] {
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_FRAMES).map((entry) => {
        const frame = asRecord(entry);
        return {
            file: asString(frame.file, MAX_CULPRIT),
            function: asString(frame.function, MAX_TAG),
            line: typeof frame.line === "number" ? frame.line : null,
            column: typeof frame.column === "number" ? frame.column : null,
            inApp: frame.inApp === true,
            context: asString(frame.context, MAX_CULPRIT) || null,
            pre: sourceLines(frame.pre).slice(-MAX_SNIPPET),
            post: sourceLines(frame.post).slice(0, MAX_SNIPPET)
        };
    });
}

/**
 * Name/value pairs as they were stored.
 *
 * `secret` is recomputed when the row does not carry one rather than defaulted
 * to false: a row written before headers were marked still has an authorization
 * header in it, and the one outcome this whole screen may not have is a live
 * token drawn in the open because of the release the row happens to date from.
 */
function storedFields(value: unknown): HeaderField[] {
    if (!Array.isArray(value)) return [];
    const fields: HeaderField[] = [];
    for (const entry of value.slice(0, MAX_HEADERS)) {
        const field = asRecord(entry);
        const name = asString(field.name, 80);
        if (!name) continue;
        fields.push({
            name,
            value: asString(field.value, MAX_VALUE),
            secret: typeof field.secret === "boolean" ? field.secret : headerIsSecret(name)
        });
    }
    return fields;
}

/** The flattened key/value lists a context group and a breadcrumb both carry. */
function storedPairs(value: unknown, limit: number): { key: string; value: string }[] {
    if (!Array.isArray(value)) return [];
    const pairs: { key: string; value: string }[] = [];
    for (const entry of value.slice(0, limit)) {
        const field = asRecord(entry);
        const key = asString(field.key, 60);
        const said = asString(field.value, MAX_VALUE);
        if (key && said) pairs.push({ key, value: said });
    }
    return pairs;
}

function storedContexts(value: unknown): ContextGroup[] {
    if (!Array.isArray(value)) return [];
    const groups: ContextGroup[] = [];
    for (const entry of value.slice(0, MAX_CONTEXTS)) {
        const group = asRecord(entry);
        const name = asString(group.name, 60);
        const fields = storedPairs(group.fields, MAX_CONTEXT_FIELDS);
        if (name && fields.length > 0) groups.push({ name, fields });
    }
    return groups;
}

function storedBreadcrumbs(value: unknown): Breadcrumb[] {
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_BREADCRUMBS).map((entry) => {
        const crumb = asRecord(entry);
        return {
            at: asString(crumb.at, 40) || null,
            type: asString(crumb.type, 40) || "default",
            category: asString(crumb.category, MAX_TAG),
            message: asString(crumb.message, MAX_TITLE),
            level: levelOf(crumb.level),
            data: storedPairs(crumb.data, MAX_CRUMB_DATA)
        };
    });
}

/** The request, or null when none was stored - which is what an older row that
 *  kept only the URL and the method also amounts to, since both of those are
 *  columns of their own and are drawn from there. */
function storedRequest(value: unknown): RequestFacts | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const request = asRecord(value);
    const url = asString(request.url, 2000) || null;
    const method = asString(request.method, 10).toUpperCase() || null;
    const query = storedFields(request.query);
    const headers = storedFields(request.headers);
    const body = typeof request.body === "string" ? request.body.slice(0, MAX_BODY) : null;
    if (!url && !method && headers.length === 0 && query.length === 0 && !body) return null;
    return { url, method, query, headers, body };
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
