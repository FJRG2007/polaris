/**
 * Remote access through Tailscale: the pure half.
 *
 * What the component reports is read by running `tailscale status --json` in its
 * container, and what the edge is asked to serve is rendered here, so both can be
 * asserted without a container engine. The service beside this module does the
 * talking to the host daemon.
 *
 * Prior art: the official `tailscale/tailscale` image's containerboot (state on
 * `TS_STATE_DIR`, a login URL printed when no `TS_AUTHKEY` is given, `TS_SERVE_CONFIG`
 * with `${TS_CERT_DOMAIN}` filled in by containerboot) and Home Assistant's
 * Tailscale add-on, which shows that login URL and offers proxy and funnel toggles.
 */

import { z } from "zod";
import { NO_ROUTES_FILE } from "@polaris/core";
import type { WafCondition, WafCustomRule } from "@polaris/core";

/** What the operator chose. Serve on and Funnel off are the defaults. */
export const tailscaleConfigSchema = z.object({
    enabled: z.boolean(),
    serve: z.boolean(),
    funnel: z.boolean()
});
export type TailscaleConfig = z.infer<typeof tailscaleConfigSchema>;

export const DEFAULT_CONFIG: TailscaleConfig = { enabled: false, serve: true, funnel: false };

/** A pasted auth key, trimmed first. Tailscale's keys start `tskey-`; anything else
 *  is a paste of the wrong thing, refused before it reaches a container. */
export const authKeySchema = z
    .string()
    .trim()
    .regex(/^tskey-[A-Za-z0-9-]{8,200}$/);

export const connectInputSchema = z.object({
    authKey: z.union([authKeySchema, z.literal("")]).optional()
});

export const togglesInputSchema = z
    .object({ serve: z.boolean(), funnel: z.boolean() })
    // Funnel is Serve opened to the internet, so it cannot be on without it.
    .refine((value) => value.serve || !value.funnel, { path: ["funnel"] });

/** Where the component stands, in the words the screen uses. */
export type TailscaleState = "off" | "starting" | "needs-login" | "connected" | "stopped";

export interface TailscaleStatus {
    readonly state: TailscaleState;
    readonly loginUrl: string | null;
    /** The machine's MagicDNS name, no trailing dot, e.g. `polaris.tail1234.ts.net`. */
    readonly host: string | null;
    readonly tailnet: string | null;
    /** How many other devices the tailnet shows this machine. */
    readonly peers: number;
    /** Whether the tailnet hands out HTTPS certificates. Null when not reported. */
    readonly https: boolean | null;
    /** Whether the tailnet policy lets this machine use Funnel. Null when not reported. */
    readonly funnelAllowed: boolean | null;
}

const LOGIN_URL = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/g;

/** The newest login link in a stretch of container output, or null. */
export function loginUrlFromLogs(text: string): string | null {
    const found = text.match(LOGIN_URL);
    return found?.[found.length - 1] ?? null;
}

const statusSchema = z
    .object({
        BackendState: z.string().optional(),
        AuthURL: z.string().optional(),
        Self: z
            .object({
                DNSName: z.string().optional(),
                Capabilities: z.array(z.string()).nullish(),
                CapMap: z.record(z.string(), z.unknown()).nullish()
            })
            .passthrough()
            .nullish(),
        CurrentTailnet: z
            .object({ Name: z.string().optional(), MagicDNSSuffix: z.string().optional() })
            .passthrough()
            .nullish(),
        Peer: z.record(z.string(), z.unknown()).nullish()
    })
    .passthrough();

/** A MagicDNS name as a bare hostname under `ts.net`, or null. */
export function tailnetHost(value: string | null | undefined): string | null {
    if (!value) return null;
    const host = value.trim().toLowerCase().replace(/\.$/, "");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(host))
        return null;
    return host;
}

function hasCap(self: z.infer<typeof statusSchema>["Self"], name: string): boolean | null {
    if (!self) return null;
    const list = self.Capabilities ?? [];
    const map = self.CapMap ? Object.keys(self.CapMap) : [];
    if (list.length === 0 && map.length === 0) return null;
    return [...list, ...map].some((cap) => cap === name || cap.endsWith(`/cap/${name}`));
}

/**
 * Read `tailscale status --json`. Anything that is not JSON of that shape reads as
 * a component still starting: the command answers before the daemon is up, and a
 * half-started daemon is not a failure to show.
 */
export function parseStatus(raw: string): TailscaleStatus {
    const starting: TailscaleStatus = {
        state: "starting",
        loginUrl: null,
        host: null,
        tailnet: null,
        peers: 0,
        https: null,
        funnelAllowed: null
    };
    let json: unknown;
    try {
        json = JSON.parse(raw.slice(raw.indexOf("{")));
    } catch {
        return starting;
    }
    const parsed = statusSchema.safeParse(json);
    if (!parsed.success) return starting;
    const status = parsed.data;
    const backend = status.BackendState ?? "";
    const loginUrl = status.AuthURL ? loginUrlFromLogs(status.AuthURL) : null;
    const state: TailscaleState =
        backend === "Running"
            ? "connected"
            : backend === "NeedsLogin" || backend === "NeedsMachineAuth"
              ? "needs-login"
              : backend === "Stopped"
                ? "stopped"
                : "starting";
    return {
        state,
        loginUrl: state === "needs-login" ? loginUrl : null,
        host: state === "connected" ? tailnetHost(status.Self?.DNSName) : null,
        tailnet: status.CurrentTailnet?.Name?.trim() || null,
        peers: status.Peer ? Object.keys(status.Peer).length : 0,
        https: hasCap(status.Self, "https"),
        funnelAllowed: hasCap(status.Self, "funnel")
    };
}

/** The edge's HTTPS port as the component dials it on the compose network. The
 *  edge's certificate is its own, so the hop is verified by neither side - it
 *  never leaves the machine. */
export const EDGE_TARGET = "https+insecure://traefik:443";

/**
 * The serve config containerboot reads from `TS_SERVE_CONFIG`. One line, so it can
 * travel as an environment value. `${TS_CERT_DOMAIN}` is containerboot's own
 * placeholder for this machine's MagicDNS name. Serve off is an empty config: the
 * machine stays in the tailnet and answers nothing.
 *
 * Each app is a port of its own, proxied to the edge under the path that names the
 * port (see `appPath`). Only an app marked public is opened by Funnel, and only on a
 * port Funnel listens on.
 */
export function renderServeConfig(
    config: Pick<TailscaleConfig, "serve" | "funnel">,
    apps: readonly TailnetApp[] = []
): string {
    if (!config.serve) return "{}";
    const site = "${TS_CERT_DOMAIN}:443";
    const tcp: Record<string, { HTTPS: true }> = { "443": { HTTPS: true } };
    const web: Record<string, { Handlers: { "/": { Proxy: string } } }> = {
        [site]: { Handlers: { "/": { Proxy: EDGE_TARGET } } }
    };
    const funnel: Record<string, boolean> = { [site]: config.funnel };
    for (const app of [...liveApps(apps)].sort((a, b) => a.port - b.port)) {
        if (app.port === 443) continue;
        const appSite = `\${TS_CERT_DOMAIN}:${app.port}`;
        tcp[String(app.port)] = { HTTPS: true };
        web[appSite] = { Handlers: { "/": { Proxy: `${EDGE_TARGET}${appPath(app.port)}` } } };
        funnel[appSite] = app.public && FUNNEL_APP_PORTS.includes(app.port);
    }
    return JSON.stringify({ TCP: tcp, Web: web, AllowFunnel: funnel });
}

const ROUTER = "polaris-tailscale";
/** Same rank as the dashboard's public hostnames: below the host-less path routers
 *  at 100 (the terminal WebSocket, the call server), which must keep winning their
 *  prefix on this name too, and above the compose catch-all at 10. */
export const TAILSCALE_PRIORITY = 50;

/** Above the machine name's own router at 50, which answers every other path on
 *  the name, and below the host-less path routers at 100, whose prefixes these never
 *  share. */
export const TAILSCALE_APP_PRIORITY = 60;

/** The edge itself, dialled from inside it: a request for an app's tailnet port is
 *  handed back to the edge under the app's own hostname. */
export const EDGE_LOOPBACK = "https://traefik:443";

/**
 * The edge route for the machine's tailnet name, and one for each app's port on it.
 * Tailscale terminates TLS with its own certificate and hands the request to the
 * edge's HTTPS port, so the routers take the edge's default certificate and ask no
 * resolver for one - an ACME order for a `ts.net` name could only fail and be
 * retried. Pure, so it can be asserted.
 *
 * An app's router never reaches the app: it strips the port's path, restores the
 * app's hostname, and sends the request round the edge again, so the app's own
 * router - guard, headers and all - is what answers. An app that is not
 * public refuses what Funnel brought in, so the dashboard's name being open to the
 * internet never opens an app's path on it too.
 *
 * The app shares the dashboard's name, and with it every cookie the browser holds for
 * it, so `cookies` - the guard's filter - hands it only its own. Without one, no app
 * is routed.
 */
export function renderTailscaleRoute(
    host: string | null,
    origin: string,
    apps: readonly TailnetApp[] = [],
    cookies = ""
): string {
    const name = tailnetHost(host);
    if (!name) return NO_ROUTES_FILE;
    const routers = [
        `    ${ROUTER}:`,
        `      rule: "Host(\`${name}\`)"`,
        "      entryPoints: [websecure]",
        `      priority: ${TAILSCALE_PRIORITY}`,
        `      service: ${ROUTER}`,
        "      tls: {}"
    ];
    const services = [
        `    ${ROUTER}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "${origin}"`
    ];
    const transports: string[] = [];
    const middlewares: string[] = [];
    for (const app of cookies ? [...liveApps(apps)].sort((a, b) => a.port - b.port) : []) {
        const id = `${ROUTER}-${app.port}`;
        const path = appPath(app.port);
        const funnel = app.public && FUNNEL_APP_PORTS.includes(app.port);
        const rule = `Host(\`${name}\`) && PathPrefix(\`${path}/\`)${
            funnel ? "" : " && !HeaderRegexp(`Tailscale-Funnel-Request`, `.`)"
        }`;
        routers.push(
            `    ${id}:`,
            `      rule: "${rule}"`,
            "      entryPoints: [websecure]",
            `      priority: ${TAILSCALE_APP_PRIORITY}`,
            `      service: ${id}`,
            `      middlewares: [${id}-cookies, ${id}-strip, ${id}-host]`,
            "      tls: {}"
        );
        services.push(
            `    ${id}:`,
            "      loadBalancer:",
            `        serversTransport: ${id}`,
            "        passHostHeader: true",
            "        servers:",
            `          - url: "${EDGE_LOOPBACK}"`
        );
        // The certificate the edge answers its own loopback with is whatever it holds
        // for the app's name, and the hop never leaves the container.
        transports.push(
            `    ${id}:`,
            `      serverName: "${app.hostname}"`,
            "      insecureSkipVerify: true"
        );
        middlewares.push(
            // The guard answers with the Cookie header the app may see, which replaces
            // the request's own; an answer without one removes it.
            `    ${id}-cookies:`,
            "      forwardAuth:",
            `        address: "${cookies}"`,
            "        authResponseHeaders: [Cookie]",
            `    ${id}-strip:`,
            "      stripPrefix:",
            `        prefixes: ["${path}"]`,
            `    ${id}-host:`,
            "      headers:",
            "        customRequestHeaders:",
            `          Host: "${app.hostname}"`,
            // The prefix is ours, not the app's: an app that honours it would write
            // links under a path the browser never saw.
            `          X-Forwarded-Prefix: ""`
        );
    }
    return [
        "http:",
        "  routers:",
        ...routers,
        "  services:",
        ...services,
        ...(transports.length > 0 ? ["  serversTransports:", ...transports] : []),
        ...(middlewares.length > 0 ? ["  middlewares:", ...middlewares] : []),
        ""
    ].join("\n");
}

/*
 * The operator's apps on the tailnet.
 *
 * A Tailscale Service would give each app a MagicDNS name of its own, but only once
 * an admin has defined it in the tailnet's console and approved a tagged host, which
 * is not something Polaris can do for the operator. So each app is a port of its own
 * on this machine's name instead: `https://<machine>.<tailnet>.ts.net:<port>`.
 *
 * The edge cannot tell those ports apart - Traefik drops the port before it matches
 * a host - so Serve tells it: each port's proxy target carries a path naming the
 * port, which Tailscale joins in front of the request's own path. The edge router
 * for that path strips it, puts the app's own hostname back in `Host`, and hands the
 * request to the edge again, where the app's own router answers it with every guard
 * and header that router already carries. Nothing on this path reaches a container
 * directly, and a name whose rules could not hold there gets no port routed at all
 * (see `holdsOnTailnet`).
 */

/** Funnel listens only on 443, 8443 and 10000, and 443 is the dashboard's. */
export const FUNNEL_APP_PORTS: readonly number[] = [8443, 10000];
/** The ports handed to apps that stay on the tailnet. */
export const APP_PORT_FIRST = 10001;
export const APP_PORT_LAST = 10999;

/** One app hostname published on the tailnet. `live` is whether the edge routes it
 *  right now; an entry that is not keeps its port, so an app that comes back gets
 *  its old address back and nobody else is handed it while there is room. */
export const tailnetAppSchema = z.object({
    hostname: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    public: z.boolean(),
    live: z.boolean()
});
export type TailnetApp = z.infer<typeof tailnetAppSchema>;
export const tailnetAppsSchema = z.array(tailnetAppSchema).max(4000);

export const appPublicInputSchema = z.object({
    hostname: z.string().trim().toLowerCase().min(1).max(253),
    public: z.boolean()
});

const APP_HOST =
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** An app hostname that can have a tailnet address: an exact name, not a wildcard,
 *  and not a tailnet name itself. */
export function tailnetAppHost(value: string): string | null {
    const host = value.trim().toLowerCase().replace(/\.$/, "");
    if (!APP_HOST.test(host) || host.endsWith(".ts.net")) return null;
    return host;
}

/**
 * Give every hostname the edge routes a port, keeping the one it already had.
 * Pure and deterministic: the same entries and the same names always give the same
 * answer, whatever order the names arrive in. A new name takes the lowest free port;
 * only when none is left is the port of a name that is no longer routed reused, the
 * longest-gone first.
 */
export function allocateAppPorts(
    previous: readonly TailnetApp[],
    hostnames: readonly string[]
): TailnetApp[] {
    const wanted = new Set(
        hostnames.map(tailnetAppHost).filter((host): host is string => host !== null)
    );
    const apps: TailnetApp[] = previous.map((app) => ({ ...app, live: wanted.has(app.hostname) }));
    const known = new Set(apps.map((app) => app.hostname));
    for (const hostname of [...wanted].sort()) {
        if (known.has(hostname)) continue;
        const used = new Set(apps.map((app) => app.port));
        let port: number | null = null;
        for (let next = APP_PORT_FIRST; next <= APP_PORT_LAST; next++) {
            if (!used.has(next)) {
                port = next;
                break;
            }
        }
        if (port === null) {
            const gone = apps.findIndex((app) => !app.live && !FUNNEL_APP_PORTS.includes(app.port));
            if (gone === -1) continue;
            port = apps[gone]!.port;
            apps.splice(gone, 1);
        }
        apps.push({ hostname, port, public: false, live: true });
    }
    return apps;
}

export type PublicRefusal = "unknown" | "no-port";

/**
 * Open an app to the internet through Funnel, or close it again. Opening moves it to
 * one of the ports Funnel listens on, taken from a name no longer routed if need be;
 * closing keeps that port, so the address does not change a second time.
 */
export function setAppPublic(
    apps: readonly TailnetApp[],
    hostname: string,
    open: boolean
): { apps: TailnetApp[] } | { refusal: PublicRefusal } {
    const index = apps.findIndex((app) => app.hostname === hostname && app.live);
    if (index === -1) return { refusal: "unknown" };
    const next = apps.map((app) => ({ ...app }));
    const app = next[index]!;
    if (!open || FUNNEL_APP_PORTS.includes(app.port)) {
        app.public = open;
        return { apps: next };
    }
    const held = new Map(next.map((entry) => [entry.port, entry]));
    const port =
        FUNNEL_APP_PORTS.find((candidate) => !held.has(candidate)) ??
        FUNNEL_APP_PORTS.find((candidate) => held.get(candidate)?.live === false);
    if (port === undefined) return { refusal: "no-port" };
    const evicted = held.get(port);
    app.port = port;
    app.public = true;
    return { apps: evicted ? next.filter((entry) => entry !== evicted) : next };
}

/** The path a port's requests arrive at the edge under. */
export function appPath(port: number): string {
    return `/.polaris-ts/${port}`;
}

/** An app's tailnet address, or null while the machine has no name. */
export function appUrl(host: string | null, port: number): string | null {
    const name = tailnetHost(host);
    return name ? `https://${name}:${port}` : null;
}

/** The parts of an app route's rules that decide who gets in. */
export interface TailnetRouteRules {
    readonly requireLogin?: boolean;
    readonly allowLists?: readonly (readonly string[])[];
    readonly deny?: readonly string[];
    readonly rules?: readonly Pick<WafCustomRule, "enabled" | "conditions">[];
}

function readsAddress(condition: WafCondition): boolean {
    if ("match" in condition) return condition.conditions.some(readsAddress);
    return "field" in condition && condition.field === "ip";
}

/**
 * Whether a route's rules still hold when it is reached on the tailnet. Rules that
 * decide by address or by sign-in do not: every request there comes round from the
 * edge itself, so an address rule sees this machine instead of the visitor, and a
 * sign-in leaves its cookie on the app's own hostname instead of the tailnet one.
 * Such a name gets no tailnet address, rather than one that admits everybody or nobody.
 */
export function holdsOnTailnet(route: TailnetRouteRules): boolean {
    if (route.requireLogin) return false;
    if ((route.allowLists ?? []).some((list) => list.length > 0)) return false;
    if ((route.deny?.length ?? 0) > 0) return false;
    return !(route.rules ?? []).some(
        (rule) => rule.enabled !== false && rule.conditions.some(readsAddress)
    );
}

/** The entries that are routed now, each with a usable name. */
export function liveApps(apps: readonly TailnetApp[]): TailnetApp[] {
    return apps.filter((app) => app.live && tailnetAppHost(app.hostname) === app.hostname);
}
