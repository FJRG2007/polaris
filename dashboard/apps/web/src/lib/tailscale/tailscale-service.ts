/**
 * Remote access through Tailscale: an on-demand component the host daemon starts
 * only when the operator turns it on in Admin > Domains.
 *
 * Off means nothing: no container, no image pulled, no route. On is one container
 * from the official image in userspace mode (no device, no capabilities), on the
 * stack's own network so it can hand requests to the edge, with its node state on a
 * named volume so a restart, a reboot or a Polaris update keeps it signed in.
 *
 * Signing in is either the login link the component prints - read back from its
 * status, never asked of the operator as a command - or an auth key pasted once and
 * kept sealed. Serve publishes this machine to the tailnet on its MagicDNS name;
 * Funnel opens the same name to the internet.
 */

import { getCapabilities } from "@polaris/config";
import type { ComposeSpec } from "@polaris/deploy";
import { dashboardOrigin } from "@/lib/domain-edge";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { TAILSCALE_PROJECT } from "@/lib/polaris-parts";
import { writeDynamicFile } from "@/lib/traefik-dynamic";
import { getSetting, setSetting } from "@/lib/setting-store";
import { openKey, sealKey } from "@/lib/deploy/wireguard/tunnel-service";
import {
    DEFAULT_CONFIG,
    loginUrlFromLogs,
    parseStatus,
    renderServeConfig,
    renderTailscaleRoute,
    tailnetHost,
    tailscaleConfigSchema,
    type TailscaleConfig,
    type TailscaleStatus
} from "./tailscale-model";

const SERVICE = "polaris-tailscale";
const IMAGE = "tailscale/tailscale:stable";
const STATE_VOLUME = "state";
const STATE_DIR = "/var/lib/tailscale";
const SERVE_FILE = "/tmp/polaris-serve.json";
const ROUTE_FILE = "polaris-tailscale.yml";
const NETWORK = process.env.POLARIS_TUNNEL_NETWORK ?? "polaris_default";

const CONFIG_KEY = "tailscale.config";
const AUTH_KEY = "tailscale.authKey";
/** The machine's tailnet name once seen connected, so the sign-in path can trust it
 *  without asking the daemon on every request. */
const HOST_KEY = "tailscale.host";

export interface TailscaleView {
    readonly edition: "full" | "limited";
    readonly config: TailscaleConfig;
    readonly status: TailscaleStatus;
    readonly hasAuthKey: boolean;
}

/** Thrown with a sentence the screen can show as it is. */
export class TailscaleRefusal extends Error {}

const OFF: TailscaleStatus = {
    state: "off",
    loginUrl: null,
    host: null,
    tailnet: null,
    peers: 0,
    https: null,
    funnelAllowed: null
};

export async function getTailscaleConfig(): Promise<TailscaleConfig> {
    const raw = await getSetting(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    try {
        const parsed = tailscaleConfigSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : DEFAULT_CONFIG;
    } catch {
        return DEFAULT_CONFIG;
    }
}

async function saveConfig(config: TailscaleConfig): Promise<void> {
    await setSetting(CONFIG_KEY, JSON.stringify(config));
}

/** The tailnet name the dashboard answers on, or null. Cheap: one setting read. */
export async function getTailscaleHost(): Promise<string | null> {
    return tailnetHost(await getSetting(HOST_KEY));
}

function edition(): "full" | "limited" {
    return getCapabilities().deploy ? "full" : "limited";
}

/** The compose spec of the component. Exported for the test that pins its shape. */
export function tailscaleSpec(config: TailscaleConfig, authKey: string | null): ComposeSpec {
    const env: Record<string, string> = {
        TS_STATE_DIR: STATE_DIR,
        TS_USERSPACE: "true",
        TS_HOSTNAME: "polaris",
        TS_ACCEPT_DNS: "false",
        TS_SERVE_CONFIG: SERVE_FILE,
        POLARIS_SERVE: renderServeConfig(config)
    };
    if (authKey) env.TS_AUTHKEY = authKey;
    return {
        project: TAILSCALE_PROJECT,
        services: [
            {
                name: SERVICE,
                image: IMAGE,
                pullPolicy: "always",
                env,
                ports: [],
                volumes: [{ source: STATE_VOLUME, target: STATE_DIR, kind: "volume" }],
                labels: {},
                // The serve config is a file to containerboot and an environment value
                // here (a file's contents cannot cross the daemon), so it is written out
                // before containerboot starts. `$POLARIS_SERVE` is expanded by the shell
                // inside the container; its own `${TS_CERT_DOMAIN}` is left for
                // containerboot, since a parameter's value is not expanded again.
                entrypoint: [
                    "/bin/sh",
                    "-c",
                    `printf '%s' "$POLARIS_SERVE" > ${SERVE_FILE} && exec /usr/local/bin/containerboot`
                ],
                networks: [NETWORK],
                restart: "unless-stopped",
                memoryMb: 256
            }
        ],
        volumes: [STATE_VOLUME],
        networks: [NETWORK]
    };
}

async function readStatus(ports: HostdPorts): Promise<TailscaleStatus> {
    const running = await ports
        .inspect(SERVICE)
        .then((info) => Boolean((info as { State?: { Running?: boolean } })?.State?.Running))
        .catch(() => null);
    if (running === null) return OFF;
    if (!running) return { ...OFF, state: "stopped" };
    const result = await ports
        .runIn(SERVICE, ["tailscale", "status", "--json"])
        .catch(() => ({ code: 1, output: "" }));
    const status = parseStatus(result.output);
    if (status.state !== "needs-login" || status.loginUrl) return status;
    // The link is in the status once the daemon has asked for it; until then it is
    // only in what containerboot printed.
    let logs = "";
    await ports
        .logs(SERVICE, (chunk) => (logs += chunk.toString("utf8")), { tail: 200, follow: false })
        .catch(() => undefined);
    return { ...status, loginUrl: loginUrlFromLogs(logs) };
}

/** Publish (or withdraw) the edge route and remember the name for sign-in. Only
 *  rewritten when the name changed, so a poll is not an edge reload. */
async function syncHost(host: string | null): Promise<void> {
    const name = tailnetHost(host);
    if (name === (await getTailscaleHost())) return;
    await writeDynamicFile(ROUTE_FILE, renderTailscaleRoute(name, dashboardOrigin()));
    await setSetting(HOST_KEY, name);
}

/** Ask the component for its name and publish it when it is connected. Nothing
 *  is asked of a component that is off or on an edition with no daemon. */
async function refreshTailscaleHost(): Promise<void> {
    if (edition() === "limited" || !(await getTailscaleConfig()).enabled) return;
    const ports = new HostdPorts();
    try {
        const status = await readStatus(ports);
        if (status.state === "connected") await syncHost(status.host);
    } finally {
        await ports.dispose();
    }
}

/** Rewrite the edge route from the remembered name, then from the live one in the
 *  background, so a slow daemon never holds up the routes published beside it.
 *  Called with the dashboard's own route, startup included. */
export async function syncTailscaleRoute(): Promise<void> {
    await writeDynamicFile(
        ROUTE_FILE,
        renderTailscaleRoute(await getTailscaleHost(), dashboardOrigin())
    );
    void refreshTailscaleHost().catch((error) =>
        console.error("polaris: reading the Tailscale name failed:", error)
    );
}

const WATCH_MS = 60_000;
const WATCHING = Symbol.for("polaris.tailscale.watch");

/** Keep the route and the trusted sign-in name in step with the component while
 *  nobody has the card open: a node that finishes signing in, or is renamed. */
export function startTailscaleWatch(): void {
    const holder = globalThis as { [WATCHING]?: boolean };
    if (holder[WATCHING]) return;
    holder[WATCHING] = true;
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await refreshTailscaleHost();
        } catch (error) {
            console.error("polaris: the Tailscale watcher failed a pass:", error);
        } finally {
            running = false;
        }
    };
    setInterval(() => void run(), WATCH_MS).unref?.();
}

/** Everything the card shows. Reads the component live; never starts it. */
export async function tailscaleView(): Promise<TailscaleView> {
    const [config, sealed] = await Promise.all([getTailscaleConfig(), getSetting(AUTH_KEY)]);
    const base = { edition: edition(), config, hasAuthKey: Boolean(sealed) };
    if (base.edition === "limited" || !config.enabled) return { ...base, status: OFF };
    const ports = new HostdPorts();
    try {
        const status = await readStatus(ports);
        if (status.state === "connected") await syncHost(status.host).catch(() => undefined);
        return { ...base, status };
    } finally {
        await ports.dispose();
    }
}

async function bringUp(config: TailscaleConfig): Promise<void> {
    const sealed = await getSetting(AUTH_KEY);
    const authKey = sealed ? openKey(sealed) : null;
    const ports = new HostdPorts();
    try {
        await ports.composeUp(tailscaleSpec(config, authKey));
    } finally {
        await ports.dispose();
    }
}

function requireFull(message: string): void {
    if (edition() === "limited") throw new TailscaleRefusal(message);
}

/**
 * Turn remote access on. A key, when given, is sealed before anything else and
 * never read back to a screen; without one the component prints a login link.
 */
export async function connectTailscale(
    authKey: string | null,
    limitedMessage: string
): Promise<void> {
    requireFull(limitedMessage);
    if (authKey) await setSetting(AUTH_KEY, sealKey(authKey));
    const config = { ...(await getTailscaleConfig()), enabled: true };
    await bringUp(config);
    await saveConfig(config);
}

/** Change Serve or Funnel. Recreates the container with the new serve config; the
 *  node state is on the volume, so it stays signed in. */
export async function setTailscaleToggles(
    toggles: { serve: boolean; funnel: boolean },
    limitedMessage: string
): Promise<void> {
    requireFull(limitedMessage);
    const current = await getTailscaleConfig();
    const config = { ...current, ...toggles };
    if (JSON.stringify(config) === JSON.stringify(current)) return;
    if (config.enabled) await bringUp(config);
    await saveConfig(config);
}

/**
 * Sign the machine out of the tailnet, stop the component and withdraw the route.
 * The stored key is forgotten too: disconnecting is the operator taking access
 * away, and a key left behind would quietly let it back in on the next connect.
 */
export async function disconnectTailscale(): Promise<void> {
    const ports = new HostdPorts();
    try {
        await ports.runIn(SERVICE, ["tailscale", "logout"]).catch(() => undefined);
        await ports.composeDown(TAILSCALE_PROJECT);
    } finally {
        await ports.dispose();
    }
    await saveConfig({ ...(await getTailscaleConfig()), enabled: false });
    await setSetting(AUTH_KEY, null);
    await writeDynamicFile(ROUTE_FILE, renderTailscaleRoute(null, dashboardOrigin()));
    await setSetting(HOST_KEY, null);
}
