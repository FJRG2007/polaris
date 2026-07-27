/**
 * Per-app OpenTunnel tunnels: expose one deployed app on a STABLE hostname of the
 * operator's own domain through an OpenTunnel server they run themselves, with no
 * tunnel provider in the path. This is the option for a box behind carrier NAT that
 * still wants its own domain: the sidecar dials out to the tunnel server
 * (`wss://<basePath>.<domain>/_tunnel`) and forwards inbound requests to the app's
 * published host port, exactly as the Cloudflare named tunnel does.
 *
 * The hostname is derived from the app, so it survives restarts and is knowable
 * before the tunnel is up: `<app>-<hash>.<basePath>.<domain>`. Server domain and
 * auth token come from the `opentunnel` integration, so credentials stay in the one
 * place that already encrypts them.
 */

import { prisma } from "@polaris/db";
import type { ComposeSpec } from "@polaris/deploy";
import { shortHash } from "@polaris/deploy";
import { HostdPorts } from "./ports-hostd";
import { getPublicIp } from "../domain-service";
import { hostPortForApp } from "../deploy-service";
import { getIntegrationSecret, getIntegrationState } from "../integration-service";
import { readOpenTunnelConfig, type OpenTunnelConfig } from "../integrations/registry";
import { openTunnelHostname, openTunnelSubdomain } from "./opentunnel-naming";

const PROXY_NETWORK = "polaris-proxy";
/**
 * The client runs from the published CLI rather than a Polaris-built image.
 * enigma: shortcut - pinned npm fetch at container start; ceiling is that a start
 * needs the registry reachable. Upgrade path: publish an opentunnel-client image
 * and swap IMAGE/command here.
 */
const IMAGE = "node:20-alpine";
const CLI_PACKAGE = "opentunnel-cli@1.0.34";

export interface OpenTunnelStatus {
    /** Whether the integration has a server domain and token configured. */
    configured: boolean;
    running: boolean;
    /** The stable public hostname, once a server domain is known. */
    hostname: string | null;
}

/** Compose project/service names for an app's tunnel (charset-safe for hostd). */
function names(appId: string): { project: string; service: string } {
    const hash = shortHash(appId, 8);
    return { project: `polaris-ottunnel-${hash}`, service: `ottunnel-${hash}` };
}

/** The enabled OpenTunnel server config plus its token, or null when incomplete. */
async function serverConfig(): Promise<{ config: OpenTunnelConfig; token: string | null } | null> {
    const state = await getIntegrationState("opentunnel");
    if (!state?.enabled) return null;
    const config = readOpenTunnelConfig(state.config);
    if (!config.domain) return null;
    return { config, token: await getIntegrationSecret("opentunnel") };
}

/** Load an app the caller owns, or throw. The sidecar runs on the Polaris host, so
 *  the app must be deployed there (a remote-host app would need its own sidecar). */
async function requireLocalApp(appId: string, ownerId: string): Promise<{ id: string; name: string }> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        include: { target: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.target.kind !== "local") {
        throw new Error("OpenTunnel tunnels are available for apps deployed on this server");
    }
    return { id: app.id, name: app.name };
}

/** The client sidecar: dial the operator's tunnel server and forward to the app's
 *  published host port. */
function tunnelSpec(
    project: string,
    service: string,
    args: { host: string; port: number; subdomain: string; config: OpenTunnelConfig; token: string | null }
): ComposeSpec {
    const command = [
        "npx",
        "-y",
        CLI_PACKAGE,
        "http",
        String(args.port),
        "-h",
        args.host,
        "-s",
        args.config.domain,
        "-n",
        args.subdomain
    ];
    // The base path is a server-side layout choice; an empty one is valid and must be
    // passed as such, or the client would fall back to its "op" default.
    command.push("-b", args.config.basePath);
    if (args.token) command.push("-t", args.token);
    if (args.config.insecure) command.push("--insecure");
    return {
        project,
        services: [
            {
                name: service,
                image: IMAGE,
                env: {},
                ports: [],
                volumes: [],
                labels: {},
                command,
                networks: [PROXY_NETWORK],
                restart: "unless-stopped"
            }
        ],
        volumes: [],
        networks: [PROXY_NETWORK]
    };
}

/**
 * Start (or restart) the app's OpenTunnel tunnel and return its stable hostname.
 * Recreated cleanly so a rotated token or a changed server is always picked up.
 */
export async function startOpenTunnel(appId: string, ownerId: string): Promise<OpenTunnelStatus> {
    const app = await requireLocalApp(appId, ownerId);
    const server = await serverConfig();
    if (!server) throw new Error("Set up the OpenTunnel integration (server domain and token) first");
    const ip = await getPublicIp();
    if (!ip) throw new Error("This server has no reachable IP to forward the tunnel to");

    const subdomain = openTunnelSubdomain(app.id, app.name);
    const { project, service } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(
            tunnelSpec(project, service, {
                host: ip,
                port: hostPortForApp(appId),
                subdomain,
                config: server.config,
                token: server.token
            })
        );
    } finally {
        await ports.dispose();
    }
    return { configured: true, running: true, hostname: openTunnelHostname(subdomain, server.config) };
}

/** Tear the app's tunnel down. Idempotent. */
export async function stopOpenTunnel(appId: string, ownerId: string): Promise<void> {
    await requireLocalApp(appId, ownerId);
    const { project } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
    } finally {
        await ports.dispose();
    }
}

/**
 * Whether the app's tunnel is up, and the hostname it serves. The hostname is
 * derived, not stored, so it is reported even while the sidecar is down - the
 * operator can point people at it before starting, and it never goes stale.
 */
export async function getOpenTunnelStatus(appId: string, ownerId: string): Promise<OpenTunnelStatus> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        select: { id: true, name: true }
    });
    if (!app) throw new Error("Application not found");
    const server = await serverConfig();
    if (!server) return { configured: false, running: false, hostname: null };

    const { service } = names(appId);
    const ports = new HostdPorts();
    try {
        const info = (await ports.inspect(service)) as { State?: { Running?: boolean } };
        return {
            configured: true,
            running: Boolean(info?.State?.Running),
            hostname: openTunnelHostname(openTunnelSubdomain(app.id, app.name), server.config)
        };
    } catch {
        return {
            configured: true,
            running: false,
            hostname: openTunnelHostname(openTunnelSubdomain(app.id, app.name), server.config)
        };
    } finally {
        await ports.dispose();
    }
}
