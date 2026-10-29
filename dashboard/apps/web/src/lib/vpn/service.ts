/**
 * The VPN: turning it on and off, where it stands, and the devices on it.
 *
 * Two installs, like the Network filter. The `vpn` app is the screens and holds
 * the settings (JSON on its own install row, key `vpn`) and runs nothing. The
 * engine (`vpn-engine`) is Headscale, a container on this machine that exists
 * only between somebody pressing Turn on and Turn off. Its whole configuration
 * is one environment value rendered from the settings.
 *
 * The dashboard reaches the engine's API the way the edge reaches a published
 * app: this machine's address and the host port the service is published on
 * (`hostPortForApp`). The dashboard's container is not on the proxy network
 * the containers share, so a container name would not resolve from here.
 *
 * Server-only.
 */

import * as rules from "./settings";
import { prisma } from "@polaris/db";
import { syncVpnEdge } from "./edge";
import { randomUUID } from "node:crypto";
import { getHostLanIp } from "@/lib/host-address";
import { setEnvVar } from "@/lib/env-var-service";
import { appBaseUrl } from "@/lib/domain-service";
import { listDeployZones } from "@/lib/domain-zones";
import { hostPortForApp } from "@/lib/deploy/host-port";
import { dnsBlockerStatus } from "@/lib/dns-blocker/service";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { openText, sealText } from "@/lib/tls/managed-certificates";
import { resolveContainerName } from "@/lib/container-files-service";
import { encodeHeadscaleConfig, PUBLIC_NAMESERVERS } from "./render";
import { installApp, uninstallApp } from "@/lib/apps/install-service";
import { addApplicationDomain, deployApplication } from "@/lib/deploy-service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { headscaleClient, type HeadscaleClient, type HeadscaleNode } from "./headscale-client";

/** The environment value the engine's entrypoint writes its configuration from. */
export const VPN_CONFIG_ENV = "HEADSCALE_CONFIG_BASE64";
const CONFIG_KEY = "vpn";
/** A preauth key is for the device being set up now, not a standing secret. */
const PREAUTH_TTL_MS = 60 * 60 * 1000;

/** Why something asked for was not done, as a key the screen says in the
 *  reader's language (`vpn` `errors.<code>`). */
export type VpnRefusalCode =
    | "notInstalled"
    | "notRunning"
    | "noHostname"
    | "noApiKey"
    | "notAllowed"
    | "notFound"
    | "badName"
    | "badAuthId"
    | "notApplied";

export class VpnRefusal extends Error {
    constructor(readonly code: VpnRefusalCode) {
        super(code);
        this.name = "VpnRefusal";
    }
}

interface EngineRow {
    readonly id: string;
    readonly ownerId: string;
    readonly applicationId: string | null;
    readonly status: string;
}

async function appRow(): Promise<{ id: string; config: string | null } | null> {
    return prisma.installedApp.findFirst({
        where: { catalogId: rules.VPN_APP, status: { not: "removed" } },
        select: { id: true, config: true },
        orderBy: { createdAt: "asc" }
    });
}

async function engineRow(): Promise<EngineRow | null> {
    return prisma.installedApp.findFirst({
        where: { catalogId: rules.VPN_ENGINE_APP, status: { not: "removed" } },
        select: { id: true, ownerId: true, applicationId: true, status: true },
        orderBy: { createdAt: "asc" }
    });
}

/** The application id of the control server, or null when it is off. Read by
 *  the edge, which publishes its routes with nothing in front (see `edge.ts`). */
export async function vpnEngineApplicationId(): Promise<string | null> {
    return (await engineRow())?.applicationId ?? null;
}

/** Whether the app is installed, without refusing when it is not. */
export async function vpnInstalled(): Promise<boolean> {
    return (await appRow()) !== null;
}

async function requireApp(): Promise<{ id: string; settings: rules.VpnSettings }> {
    const row = await appRow();
    if (!row) throw new VpnRefusal("notInstalled");
    return {
        id: row.id,
        settings: rules.readVpnSettings(readInstallConfig(row.config)[CONFIG_KEY])
    };
}

async function saveSettings(id: string, settings: rules.VpnSettings): Promise<void> {
    await patchInstallConfig(id, { [CONFIG_KEY]: settings });
}

/**
 * The resolvers the tailnet's devices ask. This machine's Network filter first
 * when it is filtering, so a device on the VPN is filtered like one at home; the
 * public resolvers after it, because the filter answers on this machine's LAN
 * address, which a device away from home reaches only once a device on that
 * network advertises it as a route. Tailscale's resolver asks the next one when
 * the first does not answer, so names keep resolving either way.
 */
async function nameservers(): Promise<string[]> {
    const filter = await dnsBlockerStatus().catch(() => null);
    const address = filter?.state === "blocking" ? filter.address : null;
    return [...(address ? [address] : []), ...PUBLIC_NAMESERVERS];
}

async function renderedConfig(settings: rules.VpnSettings): Promise<string> {
    if (!settings.hostname) throw new VpnRefusal("noHostname");
    return encodeHeadscaleConfig({
        hostname: settings.hostname,
        baseDomain: settings.baseDomain,
        nameservers: await nameservers()
    });
}

/** Where the control server stands, as the Overview explains it. */
export interface VpnStatus {
    readonly state: "off" | "starting" | "running" | "failed";
    readonly hostname: string | null;
    /** The address every client is pointed at as its login server. */
    readonly loginServer: string | null;
}

export async function vpnStatus(): Promise<VpnStatus> {
    const { settings } = await requireApp();
    const engine = await engineRow();
    const hostname = settings.hostname;
    const loginServer = hostname ? `https://${hostname}` : null;
    if (!engine?.applicationId) return { state: "off", hostname, loginServer };
    if (engine.status === "failed") return { state: "failed", hostname, loginServer };
    const healthy = await engineClient(engine, settings)
        .then((api) => api.health())
        .catch(() => false);
    return { state: healthy ? "running" : "starting", hostname, loginServer };
}

/** The deploy zones the hostname may be taken in, for the picker. */
export async function hostnameZones(): Promise<{ label: string; host: string; primary: boolean }[]> {
    return (await listDeployZones()).map(({ label, host, primary }) => ({ label, host, primary }));
}

/**
 * Create a Headscale API key inside the container, over its unix socket - the
 * only way Headscale hands out the first one. The CLI prints the key alone on
 * its last line, far under the 16 KiB an exec returns. Retried while the server
 * is still starting.
 */
async function bootstrapApiKey(engine: EngineRow): Promise<string> {
    if (!engine.applicationId) throw new VpnRefusal("notRunning");
    const app = await prisma.application.findUnique({
        where: { id: engine.applicationId },
        select: { target: true }
    });
    if (!app) throw new VpnRefusal("notRunning");
    const [ports, container] = await Promise.all([
        getPorts(app.target as TargetRow, engine.ownerId),
        resolveContainerName(engine.applicationId)
    ]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const result = await ports
            .runIn(container, ["headscale", "apikeys", "create", "--expiration", "3650d"])
            .catch(() => null);
        const key = result?.code === 0 ? apiKeyIn(result.output) : null;
        if (key) return key;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new VpnRefusal("noApiKey");
}

/** The key in what `headscale apikeys create` printed: its last word, when it
 *  looks like one. Pure; exported for tests. */
export function apiKeyIn(output: string): string | null {
    const last = output.trim().split(/\s+/).pop() ?? "";
    return /^[A-Za-z0-9._-]{16,}$/.test(last) ? last : null;
}

async function engineClient(
    engine: EngineRow,
    settings: rules.VpnSettings
): Promise<HeadscaleClient> {
    if (!engine.applicationId) throw new VpnRefusal("notRunning");
    const apiKey = openText(settings.apiKey);
    if (!apiKey) throw new VpnRefusal("noApiKey");
    const address = (await getHostLanIp().catch(() => null)) ?? "host.docker.internal";
    return headscaleClient(`http://${address}:${hostPortForApp(engine.applicationId)}`, apiKey);
}

/** The client for the running server, or a refusal saying why there is none. */
async function client(): Promise<HeadscaleClient> {
    const { settings } = await requireApp();
    const engine = await engineRow();
    if (!engine) throw new VpnRefusal("notRunning");
    return engineClient(engine, settings);
}

async function publishEdge(hostname: string | null): Promise<void> {
    await syncVpnEdge({ hostname, dashboardUrl: await appBaseUrl() });
}

/**
 * Start the control server, or deploy it again when it exists - which is also
 * Retry. Only ever called from an administrator's press.
 *
 * The first time, the hostname can only be taken once the service exists (a
 * domain belongs to an application), so the server is installed with a
 * provisional address, given its hostname, and deployed again with the
 * configuration that names it. The API key is created last, inside the running
 * server, and kept sealed on the install row.
 */
export async function turnOn(
    actorId: string,
    choice: { zoneLabel?: string; subdomain: string }
): Promise<void> {
    const app = await requireApp();
    let settings = app.settings;
    let engine = await engineRow();
    if (!engine) {
        const provisional = encodeHeadscaleConfig({
            hostname: settings.hostname ?? "localhost",
            baseDomain: settings.baseDomain,
            nameservers: PUBLIC_NAMESERVERS
        });
        await installApp(
            actorId,
            actorId,
            {
                catalogId: rules.VPN_ENGINE_APP,
                name: "VPN control server", // i18n-ignore
                serverId: "local",
                storage: [],
                env: []
            },
            undefined,
            // Seeded rather than passed as a form value: the configuration is
            // longer than any value a form may send.
            {
                installedAppId: randomUUID(),
                env: [{ key: VPN_CONFIG_ENV, value: provisional, isSecret: false }]
            }
        );
        engine = await engineRow();
    }
    if (!engine?.applicationId) throw new VpnRefusal("notRunning");
    if (!settings.hostname) {
        const hostname = await addApplicationDomain(engine.applicationId, engine.ownerId, {
            targetPort: rules.VPN_PORT,
            cert: "le",
            zoneLabel: choice.zoneLabel ?? "",
            subdomain: choice.subdomain || rules.DEFAULT_SUBDOMAIN
        });
        settings = { ...settings, hostname };
        await saveSettings(app.id, settings);
    }
    await setEnvVar("application", engine.applicationId, engine.ownerId, {
        key: VPN_CONFIG_ENV,
        value: await renderedConfig(settings),
        isSecret: false
    });
    try {
        await deployApplication(engine.applicationId, engine.ownerId, actorId);
        await prisma.installedApp.update({ where: { id: engine.id }, data: { status: "running" } });
    } catch (error) {
        console.error("polaris: the VPN's control server did not deploy:", error);
        await prisma.installedApp.update({ where: { id: engine.id }, data: { status: "failed" } });
        throw new VpnRefusal("notApplied");
    }
    await publishEdge(settings.hostname);
    if (!openText(settings.apiKey)) {
        const key = await bootstrapApiKey(engine);
        await saveSettings(app.id, { ...settings, apiKey: sealText(key) });
    }
}

/**
 * Stop the control server and remove it. Its database goes with it, and with it
 * every device's sign-in, so the screen asks first. The API key goes too, since
 * it named a database that is gone, and so does the hostname, whose domain row
 * belonged to the removed service.
 */
export async function turnOff(): Promise<void> {
    const app = await requireApp();
    const engine = await engineRow();
    await publishEdge(null);
    if (engine) await uninstallApp(engine.ownerId, engine.id, { deleteData: true });
    await saveSettings(app.id, { ...app.settings, hostname: null, apiKey: null });
}

/** A device as the screens show it. */
export interface VpnDevice {
    readonly id: string;
    readonly name: string;
    readonly owner: { readonly name: string; readonly displayName: string; readonly email: string };
    readonly addresses: readonly string[];
    readonly online: boolean;
    readonly lastSeen: string | null;
    readonly exitNode: { readonly offered: boolean; readonly approved: boolean };
    /** Subnet routes the device advertises, each with whether it is approved. */
    readonly routes: readonly { readonly route: string; readonly approved: boolean }[];
}

/** A node as the screens show it. Pure; exported for tests. */
export function deviceOf(node: HeadscaleNode): VpnDevice {
    const approved = new Set(node.approvedRoutes);
    return {
        id: node.id,
        name: node.givenName || node.name,
        owner: {
            name: node.user?.name ?? "",
            displayName: node.user?.displayName ?? "",
            email: node.user?.email ?? ""
        },
        addresses: node.ipAddresses,
        online: node.online,
        lastSeen: node.lastSeen,
        exitNode: {
            offered: rules.EXIT_ROUTES.every((route) => node.availableRoutes.includes(route)),
            approved: rules.EXIT_ROUTES.every((route) => approved.has(route))
        },
        routes: node.availableRoutes
            .filter((route) => !rules.isExitRoute(route))
            .map((route) => ({ route, approved: approved.has(route) }))
    };
}

/** The nodes `viewer` may see: every one for an administrator, their own
 *  otherwise - asked of the server by user, never filtered here after the fact. */
async function visibleNodes(api: HeadscaleClient, viewer: rules.VpnViewer) {
    return viewer.isAdmin
        ? api.listNodes()
        : api.listNodes(rules.headscaleUserName(viewer.id));
}

export async function listDevices(viewer: rules.VpnViewer): Promise<VpnDevice[]> {
    const nodes = await visibleNodes(await client(), viewer);
    return nodes.map(deviceOf).sort((a, b) => a.name.localeCompare(b.name));
}

/** A device `viewer` may change, or the refusal. */
async function ownedNode(
    api: HeadscaleClient,
    viewer: rules.VpnViewer,
    nodeId: string
): Promise<HeadscaleNode> {
    const node = (await visibleNodes(api, viewer)).find((one) => one.id === nodeId);
    if (!node) throw new VpnRefusal("notFound");
    if (!rules.mayManageDevice(viewer, node.user?.name ?? "")) throw new VpnRefusal("notAllowed");
    return node;
}

export async function renameDevice(
    viewer: rules.VpnViewer,
    nodeId: string,
    name: string
): Promise<VpnDevice> {
    const parsed = rules.deviceNameSchema.safeParse(name);
    if (!parsed.success) throw new VpnRefusal("badName");
    const api = await client();
    await ownedNode(api, viewer, nodeId);
    return deviceOf(await api.renameNode(nodeId, parsed.data));
}

export async function removeDevice(viewer: rules.VpnViewer, nodeId: string): Promise<void> {
    const api = await client();
    await ownedNode(api, viewer, nodeId);
    await api.deleteNode(nodeId);
}

/**
 * The routes to approve on a device: its exit node and the subnet routes asked
 * for, limited to what it advertises, so nothing is approved that it never
 * offered. Pure; exported for tests.
 */
export function approvedRoutesFor(
    available: readonly string[],
    wanted: { exitNode: boolean; routes: readonly string[] }
): string[] {
    const offered = new Set(available);
    const routes = [
        ...(wanted.exitNode ? rules.EXIT_ROUTES : []),
        ...wanted.routes.filter((route) => !rules.isExitRoute(route))
    ].filter((route) => offered.has(route));
    return [...new Set(routes)];
}

/**
 * Approve or withdraw what a device offers. Administrators only: with no access
 * policy yet, an approved route is one every device on the tailnet can use.
 */
export async function setDeviceRoutes(
    viewer: rules.VpnViewer,
    nodeId: string,
    wanted: { exitNode: boolean; routes: readonly string[] }
): Promise<VpnDevice> {
    if (!rules.mayApproveRoutes(viewer)) throw new VpnRefusal("notAllowed");
    const api = await client();
    const node = await ownedNode(api, viewer, nodeId);
    return deviceOf(await api.approveRoutes(nodeId, approvedRoutesFor(node.availableRoutes, wanted)));
}

interface Account {
    readonly id: string;
    readonly name: string;
    readonly email: string;
}

/** The Headscale user for a Polaris account, created the first time it is needed. */
async function ensureUser(api: HeadscaleClient, account: Account) {
    const name = rules.headscaleUserName(account.id);
    const found = (await api.listUsers(name)).find((user) => user.name === name);
    if (found) return found;
    return api.createUser({ name, displayName: account.name, email: account.email });
}

/** A one-time key that signs one device in as `account`, valid for an hour. */
export async function createDeviceKey(
    account: Account
): Promise<{ key: string; expiresAt: string }> {
    const api = await client();
    const user = await ensureUser(api, account);
    const expiration = new Date(Date.now() + PREAUTH_TTL_MS);
    const key = await api.createPreAuthKey({
        userId: user.id,
        reusable: false,
        ephemeral: false,
        expiration
    });
    return { key: key.key, expiresAt: expiration.toISOString() };
}

/** Add the device waiting at `authId` to `account`'s devices. */
export async function registerDevice(account: Account, authId: string): Promise<VpnDevice> {
    const parsed = rules.authIdSchema.safeParse(authId);
    if (!parsed.success) throw new VpnRefusal("badAuthId");
    const api = await client();
    const user = await ensureUser(api, account);
    return deviceOf(await api.registerNode(user.name, parsed.data));
}
