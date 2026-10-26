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
 */
export function renderServeConfig(config: Pick<TailscaleConfig, "serve" | "funnel">): string {
    if (!config.serve) return "{}";
    const site = "${TS_CERT_DOMAIN}:443";
    return JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: { [site]: { Handlers: { "/": { Proxy: EDGE_TARGET } } } },
        AllowFunnel: { [site]: config.funnel }
    });
}

const ROUTER = "polaris-tailscale";
/** Same rank as the dashboard's public hostnames: below the host-less path routers
 *  at 100 (the terminal WebSocket, the call server), which must keep winning their
 *  prefix on this name too, and above the compose catch-all at 10. */
export const TAILSCALE_PRIORITY = 50;

/**
 * The edge route for the machine's tailnet name. Tailscale terminates TLS with its
 * own certificate and hands the request to the edge's HTTPS port, so the router
 * takes the edge's default certificate and asks no resolver for one - an ACME order
 * for a `ts.net` name could only fail and be retried. Pure, so it can be asserted.
 */
export function renderTailscaleRoute(host: string | null, origin: string): string {
    const name = tailnetHost(host);
    if (!name) return "http: {}\n";
    return [
        "http:",
        "  routers:",
        `    ${ROUTER}:`,
        `      rule: "Host(\`${name}\`)"`,
        "      entryPoints: [websecure]",
        `      priority: ${TAILSCALE_PRIORITY}`,
        `      service: ${ROUTER}`,
        "      tls: {}",
        "  services:",
        `    ${ROUTER}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "${origin}"`,
        ""
    ].join("\n");
}
