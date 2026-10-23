/**
 * The HTTP request node and the chat presets built on it (Slack, Discord,
 * Teams: the HTTP node with a fixed body from `webhook-sender.ts`).
 *
 * Every request goes through the guarded fetch: public addresses only, through
 * the vetted dispatcher, redirects followed by hand so every hop is checked
 * like the first. The one exception is an automation an administrator allowed
 * onto the local network, and everything that decides what that opens is
 * `localNetworkPolicy` below.
 */

import * as core from "@polaris/core";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { Agent, fetch as guardedFetch } from "undici";
import { offlineFor } from "@/lib/offline/outbound-lookup";
import { StepError, type NodeIo, type RunContext, type ServerNode } from "../types";
import {
    configuredRequest,
    readCapped,
    RefusedAddressError,
    resolveName,
    safeUrl
} from "@/lib/safe-fetch";

const L = core.AUTOMATION_LIMITS;

// ---------------------------------------------------------------------------
// The local network policy
// ---------------------------------------------------------------------------

/**
 * Private LAN ranges an allowed automation may reach. Everything else that is
 * not public stays shut even with the switch on: loopback (127.0.0.0/8, ::1),
 * link-local and cloud metadata (169.254.0.0/16 incl. 169.254.169.254,
 * fe80::/10), and Polaris's own services.
 */
const LAN_V4: readonly [number, number][] = [
    [ipv4ToInt("10.0.0.0"), 8],
    [ipv4ToInt("172.16.0.0"), 12],
    [ipv4ToInt("192.168.0.0"), 16]
];

function ipv4ToInt(address: string): number {
    return address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

function inV4(address: string, base: number, bits: number): boolean {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4ToInt(address) & mask) >>> 0 === (base & mask) >>> 0;
}

function unmapped(address: string): string {
    const lower = address.toLowerCase();
    return lower.startsWith("::ffff:") && lower.includes(".") ? lower.slice(7) : lower;
}

/** Whether an address is in one of the LAN ranges the switch opens. */
export function isLanAddress(raw: string): boolean {
    const address = unmapped(raw);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(address))
        return LAN_V4.some(([base, bits]) => inV4(address, base, bits));
    // fc00::/7 - unique local addresses.
    return /^f[cd][0-9a-f]{0,2}:/i.test(address);
}

/** Names Polaris's own containers answer to, from its own configuration. */
function internalHostnames(): string[] {
    const names = new Set<string>([
        "postgres",
        "redis",
        "traefik",
        "hostd",
        "polaris-hostd",
        "polaris-web",
        "livekit"
    ]);
    for (const key of ["DATABASE_URL", "REDIS_URL", "POLARIS_HOSTD_URL", "LIVEKIT_URL"]) {
        const value = process.env[key];
        if (!value) continue;
        try {
            names.add(new URL(value).hostname.toLowerCase());
        } catch {
            // Not a URL: nothing to add.
        }
    }
    return [...names].filter(Boolean);
}

/** The addresses of Polaris's own services and of this container, resolved now. */
async function internalAddresses(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const list of Object.values(networkInterfaces()))
        for (const entry of list ?? []) out.add(unmapped(entry.address));
    await Promise.all(
        internalHostnames().map(async (name) => {
            const found = offlineFor(name) ? [] : await lookup(name, { all: true }).catch(() => []);
            for (const entry of found) out.add(unmapped(entry.address));
        })
    );
    return out;
}

/**
 * The one place that decides whether a step's request may go to the local
 * network, and to which addresses.
 *
 * - The switch is the automation's own (`allowLocalNetwork`), off by default,
 *   set only by an administrator (`mayAllowLocalNetwork` in runner.ts) and
 *   audited. Off: public addresses only, exactly the guarded fetch.
 * - On: a resolved address must be public or in a LAN range, and must not be
 *   one of Polaris's own services or this container's own address.
 * - It is applied at connect time for every request and every redirect hop, so
 *   a name that resolves to something else the second time (DNS rebinding) is
 *   refused on that hop.
 */
export const localNetworkPolicy = {
    allowed(io: Pick<NodeIo, "allowLocalNetwork">): boolean {
        return io.allowLocalNetwork;
    },
    /** Every resolved address of one name, or the reason the name may not be reached. */
    async vet(hostname: string): Promise<{ address: string; family: number }[] | Error> {
        const literal = hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(literal)
            ? [{ address: literal, family: isIP(literal) }]
            : await resolveName(hostname).catch(() => []);
        if (addresses.length === 0) return new Error(`${hostname} does not resolve`);
        const internal = await internalAddresses();
        for (const entry of addresses) {
            const address = unmapped(entry.address);
            if (internal.has(address))
                return new Error(`${hostname} is one of Polaris's own services`);
            if (core.isPrivateIp(address) && !isLanAddress(address))
                return new Error(`${hostname} resolves to a blocked address`);
        }
        return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
    }
};

const lanDispatcher = new Agent({
    connect: {
        lookup(hostname, options, callback) {
            localNetworkPolicy.vet(hostname).then(
                (vetted) => {
                    if (vetted instanceof Error) return callback(vetted, "", 0);
                    if (options.all) return callback(null, vetted);
                    callback(null, vetted[0]!.address, vetted[0]!.family);
                },
                (error: Error) => callback(error as NodeJS.ErrnoException, "", 0)
            );
        }
    }
});

/** One hop, through the guarded fetch or, for an allowed automation, the LAN-vetted dispatcher. */
async function oneHop(
    url: string,
    init: RequestInit & { timeoutMs: number },
    io: NodeIo
): Promise<Response> {
    if (!localNetworkPolicy.allowed(io))
        return configuredRequest(url, init, { allowPrivate: false });
    const checked = safeUrl(url, Number.POSITIVE_INFINITY);
    if (!checked) throw new RefusedAddressError();
    if (
        isIP(checked.hostname.replace(/^\[|\]$/g, "")) &&
        (await localNetworkPolicy.vet(checked.hostname)) instanceof Error
    )
        throw new RefusedAddressError();
    const { timeoutMs, ...rest } = init;
    return (await guardedFetch(checked, {
        ...(rest as Parameters<typeof guardedFetch>[1]),
        redirect: "manual",
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), io.signal]),
        dispatcher: lanDispatcher
    })) as unknown as Response;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const DROPPED_HEADERS = new Set([
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "cookie"
]);
const KEPT_RESPONSE_HEADERS = [
    "content-type",
    "content-length",
    "location",
    "retry-after",
    "etag",
    "last-modified",
    "date",
    "x-request-id"
];

interface Outgoing {
    method: string;
    url: string;
    headers: Headers;
    body: string | null;
    timeoutMs: number;
    /** Headers carrying a secret, dropped when a redirect leaves the origin. */
    secretHeaders?: readonly string[];
}

const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"];

async function send(request: Outgoing, io: NodeIo): Promise<{ response: Response; url: string }> {
    let { method, body } = request;
    let url = request.url;
    for (let hop = 0; hop <= L.httpRedirects; hop++) {
        let response: Response;
        try {
            response = await oneHop(
                url,
                { method, headers: request.headers, body, timeoutMs: request.timeoutMs },
                io
            );
        } catch (caught) {
            if (caught instanceof RefusedAddressError) throw new StepError("addressRefused");
            const name = (caught as { name?: string } | null)?.name;
            if (name === "TimeoutError" || name === "AbortError") throw new StepError("timeout");
            throw new StepError("unreachable");
        }
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
            await response.body?.cancel().catch(() => undefined);
            let next: URL;
            try {
                next = new URL(location, url);
            } catch {
                throw new StepError("badRedirect");
            }
            if (next.origin !== new URL(url).origin)
                for (const name of [...CREDENTIAL_HEADERS, ...(request.secretHeaders ?? [])])
                    request.headers.delete(name);
            url = next.href;
            if (
                response.status === 303 ||
                ((response.status === 301 || response.status === 302) && method === "POST")
            ) {
                method = "GET";
                body = null;
                request.headers.delete("content-type");
            }
            continue;
        }
        return { response, url };
    }
    throw new StepError("tooManyRedirects");
}

async function readBody(response: Response, method: string): Promise<unknown> {
    if (method === "HEAD" || !response.body) return null;
    const bytes = await readCapped(response as never, L.httpResponseBytes);
    if (!bytes) throw new StepError("responseTooLarge");
    const textBody = new TextDecoder().decode(bytes);
    if ((response.headers.get("content-type") ?? "").includes("json")) {
        try {
            return JSON.parse(textBody);
        } catch {
            return textBody;
        }
    }
    return textBody;
}

function keptHeaders(response: Response): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of KEPT_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) out[name] = value;
    }
    return out;
}

async function answer(
    response: Response,
    method: string,
    acceptAnyStatus: boolean
): Promise<{ output: unknown }> {
    const body = await readBody(response, method);
    const output = {
        status: response.status,
        ok: response.ok,
        headers: keptHeaders(response),
        body
    };
    if (!response.ok && !acceptAnyStatus)
        throw new StepError(`httpStatus:${response.status}`, output);
    return { output };
}

/** The request an HTTP node describes, with references filled in and secrets applied. */
export async function buildHttpRequest(
    config: core.HttpConfig,
    context: RunContext,
    io: NodeIo
): Promise<Outgoing> {
    const base = config.urlSecretId
        ? await io.secret(config.urlSecretId)
        : core.interpolate(config.url, context).trim();
    let url: URL;
    try {
        url = new URL(base);
    } catch {
        throw new StepError("badUrl");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new StepError("badUrl");
    for (const pair of config.query)
        url.searchParams.append(pair.name, core.interpolate(pair.value, context));

    const headers = new Headers();
    for (const pair of config.headers) {
        if (DROPPED_HEADERS.has(pair.name.toLowerCase())) continue;
        try {
            headers.set(pair.name, core.interpolate(pair.value, context));
        } catch {
            throw new StepError("badHeader");
        }
    }
    if (config.auth.kind === "bearer")
        headers.set("authorization", `Bearer ${await io.secret(config.auth.secretId)}`);
    if (config.auth.kind === "basic")
        headers.set(
            "authorization",
            `Basic ${Buffer.from(await io.secret(config.auth.secretId)).toString("base64")}`
        );
    if (config.auth.kind === "header")
        headers.set(config.auth.header, await io.secret(config.auth.secretId));
    headers.set("idempotency-key", io.idempotencyKey);
    headers.set("user-agent", "Polaris-Automations");

    let body: string | null = null;
    const method = config.method;
    if (method !== "GET" && method !== "HEAD") {
        if (config.body.kind === "json") {
            body = JSON.stringify(core.jsonWithReferences(JSON.parse(config.body.json), context));
            headers.set("content-type", "application/json");
        } else if (config.body.kind === "form") {
            const form = new URLSearchParams();
            for (const pair of config.body.fields)
                form.append(pair.name, core.interpolate(pair.value, context));
            body = form.toString();
            headers.set("content-type", "application/x-www-form-urlencoded");
        } else if (config.body.kind === "text") {
            body = core.interpolate(config.body.text, context);
            if (!headers.has("content-type"))
                headers.set("content-type", "text/plain; charset=utf-8");
        }
    }
    if (body !== null && core.byteLength(body) > L.eventPayloadBytes)
        throw new StepError("bodyTooLarge");
    const secretHeaders = config.auth.kind === "header" ? [config.auth.header] : [];
    return {
        method,
        url: url.href,
        headers,
        body,
        timeoutMs: config.timeoutSeconds * 1000,
        secretHeaders
    };
}

const httpNode: ServerNode<core.HttpConfig> = {
    type: "core.http",
    meta: core.CORE_NODE_META["core.http"],
    config: core.CORE_NODE_CONFIGS["core.http"],
    timeoutMs: L.httpTimeoutMs + 5_000,
    run: async (config, context, io) => {
        const request = await buildHttpRequest(config, context, io);
        io.recordInput({
            method: request.method,
            url: request.url,
            headers: [...request.headers.keys()],
            bytes: request.body?.length ?? 0
        });
        const { response } = await send(request, io);
        return answer(response, request.method, config.acceptAnyStatus);
    }
};

type ChatConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.chat"]["parse"]>;

const chatNode: ServerNode<ChatConfig> = {
    type: "core.chat",
    meta: core.CORE_NODE_META["core.chat"],
    config: core.CORE_NODE_CONFIGS["core.chat"],
    timeoutMs: L.httpTimeoutMs + 5_000,
    run: async (config, context, io) => {
        const { bodyFor } = await import("@/lib/notifications/webhook-sender");
        const url = await io.secret(config.secretId);
        const payload = {
            event: "automations.message",
            level: config.level,
            title: core.interpolate(config.title, context).slice(0, 256),
            body: core.interpolate(config.text, context) || null,
            url: core.interpolate(config.link, context).trim() || null,
            at: new Date().toISOString()
        };
        io.recordInput({
            preset: config.preset,
            title: payload.title,
            body: payload.body,
            url: payload.url
        });
        const headers = new Headers({
            "content-type": "application/json",
            "user-agent": "Polaris-Automations"
        });
        const { response } = await send(
            {
                method: "POST",
                url,
                headers,
                body: JSON.stringify(bodyFor(config.preset, payload)),
                timeoutMs: 15_000
            },
            io
        );
        return answer(response, "POST", false);
    }
};

export const HTTP_SERVER_NODES: readonly ServerNode[] = [
    httpNode as ServerNode,
    chatNode as ServerNode
];
