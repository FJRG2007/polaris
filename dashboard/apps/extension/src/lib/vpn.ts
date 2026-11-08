/**
 * The VPN in this browser: its traffic leaves through a Polaris server's proxy,
 * the rest of the machine stays as it was.
 *
 * Chromium sets the proxy once and is asked for the login when the proxy wants
 * it; Firefox decides request by request and carries the login on each. Both end
 * at the same two things held here: the route, in `storage.local` so it outlives
 * a restart like the browser's proxy setting does, and an hour's login, in
 * `storage.session` because it is a credential. A login that ran out is fetched
 * again when the proxy asks, so nothing has to keep running to renew it.
 *
 * Either way the browser only hands over requests to sites the extension may
 * reach, so connecting takes access to every site: without it Firefox would send
 * the rest straight out while the popup said connected.
 *
 * The Polaris server stays outside the tunnel, or a login that ran out could not
 * be renewed through the proxy it is for. So do local addresses: a printer or
 * this Polaris on the home network stay reachable while connected.
 */

import { EVERY_SITE } from "@/lib/injection";
import { countryCode } from "@/lib/vpn-places";

/** A server this account may leave through. */
export interface VpnNode {
    readonly id: string;
    readonly name: string;
    /** "direct" or "tor". */
    readonly exit: string;
    /** False while the server has no address a browser can reach it by. */
    readonly browser: boolean;
    /** Why not, while `browser` is false; null when the host did not say, as one
     *  older than this reason does. */
    readonly browserIssue: VpnBrowserIssue | null;
    /** Where traffic comes out, as a two-letter country code and a city; null where
     *  the host has not placed it or is too old to say. */
    readonly country: string | null;
    readonly city: string | null;
}

export type VpnBrowserIssue = "edge" | "address" | "failed";

function browserIssueOf(value: unknown): VpnBrowserIssue | null {
    return value === "edge" || value === "address" || value === "failed" ? value : null;
}

export interface VpnRoute {
    readonly origin: string;
    readonly nodeId: string;
    readonly nodeName: string;
    readonly host: string;
    readonly port: number;
    /** When this connection was made, in milliseconds since the epoch. Missing on a
     *  route saved before it was kept. */
    readonly since?: number;
}

export interface VpnLogin {
    readonly username: string;
    readonly password: string;
    /** Seconds since the epoch, as the server signed it. */
    readonly expiresAt: number;
}

export interface VpnState {
    /** False where this Polaris has no VPN for this account, or is too old to. */
    readonly available: boolean;
    readonly nodes: readonly VpnNode[];
    readonly active: {
        readonly nodeId: string;
        readonly nodeName: string;
        /** When it connected; null where the saved route predates keeping it. */
        readonly since: number | null;
    } | null;
    /** Whether WebRTC is held to the proxy while connected; null where this browser
     *  cannot be asked to. */
    readonly webRtcGuard: boolean | null;
    /** Who holds the browser's proxy instead of Polaris; null when nobody does, or
     *  on Firefox, which decides request by request and has no such holder. Missing
     *  from a worker older than this. */
    readonly conflict?: ProxyConflict | null;
}

/** Another extension, as `management.getAll` describes it. */
export interface ManagedExtension {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly type?: string;
    readonly permissions?: readonly string[];
    readonly icons?: readonly { readonly size: number; readonly url: string }[];
    readonly mayDisable?: boolean;
}

/** An extension that may be holding the proxy, as the popup draws it. */
export interface ConflictExtension {
    readonly id: string;
    readonly name: string;
    readonly icon: string | null;
    /** False for one the browser's administrator installed: only they can remove it. */
    readonly mayDisable: boolean;
}

/**
 * Why Polaris cannot set the proxy. `policy` is the browser's administrator,
 * which no button here can change. `extensions` is another extension: the ones
 * that may hold it, or null while Polaris has not been allowed to look.
 */
export type ProxyConflict =
    | { readonly kind: "policy" }
    | { readonly kind: "extensions"; readonly extensions: readonly ConflictExtension[] | null };

/** The icon nearest 32px, from the sizes an extension ships. */
function iconOf(icons: ManagedExtension["icons"]): string | null {
    const sorted = [...(icons ?? [])].sort((a, b) => a.size - b.size);
    return (sorted.find((icon) => icon.size >= 32) ?? sorted.at(-1))?.url ?? null;
}

/**
 * Who holds the proxy, from the setting's level of control and the installed
 * extensions. The browser does not name the holder, so every enabled extension
 * that may set a proxy is listed: the most recently installed of them is the one
 * in control, and the next takes over as soon as that one is off.
 */
export function proxyConflict(
    levelOfControl: string | undefined,
    extensions: readonly ManagedExtension[] | null,
    selfId: string | undefined
): ProxyConflict | null {
    if (levelOfControl === "not_controllable") return { kind: "policy" };
    if (levelOfControl !== "controlled_by_other_extensions") return null;
    if (extensions === null) return { kind: "extensions", extensions: null };
    return {
        kind: "extensions",
        extensions: extensions
            .filter(
                (one) =>
                    one.id !== selfId &&
                    one.enabled &&
                    (one.type ?? "extension") === "extension" &&
                    (one.permissions ?? []).includes("proxy")
            )
            .map((one) => ({
                id: one.id,
                name: one.name,
                icon: iconOf(one.icons),
                mayDisable: one.mayDisable !== false
            }))
    };
}

/** The proxy's level of control, as the refusal it means for connecting. */
function refusalOf(levelOfControl: string | undefined): VpnRefusal | null {
    if (levelOfControl === "controlled_by_other_extensions") return "blocked";
    return levelOfControl === "not_controllable" ? "policy" : null;
}

export type VpnRefusal =
    "noSites" | "noAccess" | "notReady" | "unreachable" | "blocked" | "policy" | "noTraffic";

export type VpnOutcome = { readonly ok: true } | { readonly ok: false; readonly code: VpnRefusal };

type Stored<T> = { getValue(): Promise<T>; setValue(value: T): Promise<unknown> };

interface AuthDetails {
    readonly requestId: string;
    readonly isProxy?: boolean;
    readonly challenger?: { readonly host: string; readonly port: number };
}

type AuthAnswer = { authCredentials?: { username: string; password: string }; cancel?: boolean };

interface ProxySetting {
    set(detail: { value: unknown; scope: "regular" }): Promise<unknown>;
    clear(detail: { scope: "regular" }): Promise<unknown>;
    get(detail: object): Promise<{ levelOfControl?: string }>;
    readonly onChange?: {
        addListener(listener: (detail: { levelOfControl?: string }) => void): void;
    };
}

/** The parts of the browser this touches, so a test can stand in for them. */
export interface VpnApi {
    readonly proxy?: {
        readonly settings?: ProxySetting;
        readonly onRequest?: {
            addListener(
                listener: (info: { url: string }) => Promise<unknown>,
                filter: { urls: string[] }
            ): void;
        };
    };
    readonly webRequest?: {
        readonly onAuthRequired?: {
            addListener(
                listener: (details: AuthDetails, callback: (answer: AuthAnswer) => void) => void,
                filter: { urls: string[] },
                extra: string[]
            ): void;
        };
    };
    readonly privacy?: {
        readonly network?: {
            readonly webRTCIPHandlingPolicy?: Pick<ProxySetting, "set" | "clear">;
        };
    };
    /** Only there once the optional `management` permission is granted. */
    readonly management?: {
        getAll?(): Promise<ManagedExtension[]>;
    };
    readonly permissions?: {
        contains(detail: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
        readonly onRemoved?: {
            addListener(listener: (removed: { origins?: string[] }) => void): void;
        };
    };
}

export interface VpnDeps {
    readonly api: VpnApi;
    readonly route: Stored<VpnRoute | null>;
    readonly login: Stored<VpnLogin | null>;
    /** Whether WebRTC is held to the proxy while connected. Its fallback is true, so
     *  an install that never chose has it on. */
    readonly webRtcGuard: Stored<boolean>;
    /** The connected Polaris and its token, as every other call reads them. */
    readonly link: () => Promise<{ origin: string | null; token: string | null }>;
    /** Every Polaris this browser knows, kept out of the tunnel. */
    readonly origins: () => Promise<readonly string[]>;
    /** Redraws the toolbar. */
    readonly changed: () => void | Promise<void>;
    /** Whether requests are decided one at a time, which is Firefox. */
    readonly perRequest: boolean;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    /** This extension's own id, never listed as the one holding the proxy. */
    readonly selfId?: string;
}

const TIMEOUT_MS = 15_000;
/** Answers with nothing, from a host that exists everywhere: whether traffic flows. */
const PROBE_URL = "https://www.gstatic.com/generate_204";
/** Answered by the proxy alone and by nothing on the internet, so a reply proves this
 *  browser's requests really reach it. `PROXY_PROOF_HOST` on the server. */
const PROOF_URL = "http://polaris-vpn-proof.invalid/";
/** Where Firefox is sent while connected with no login to hand: nothing listens, so
 *  requests fail instead of leaving on the real address. */
const NO_WAY_OUT = { type: "http", host: "127.0.0.1", port: 1 };
/** A login this close to its end is replaced rather than sent. */
const LOGIN_MARGIN_SECONDS = 60;
/** After this many tries the proxy is refusing the login, not asking for one. */
const AUTH_TRIES = 2;
const LOCAL_RANGES = ["<local>", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];
const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

function hostnameOf(address: string): string | null {
    try {
        return new URL(address).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/** What Chromium's list keeps out of the proxy. */
export function bypassList(origins: readonly string[]): string[] {
    const hosts = origins.flatMap((origin) => hostnameOf(origin) ?? []);
    return [...LOCAL_RANGES, ...new Set(hosts)];
}

/** The same rule request by request, for Firefox. */
export function staysOutside(url: string, origins: readonly string[]): boolean {
    const host = hostnameOf(url);
    if (host === null) return true;
    if (!host.includes(".") || host.endsWith(".local") || PRIVATE_V4.test(host)) return true;
    return origins.some((origin) => hostnameOf(origin) === host);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function readNodes(value: unknown): VpnNode[] {
    if (!isObject(value) || !Array.isArray(value.nodes)) return [];
    return value.nodes.flatMap((node: unknown) =>
        isObject(node) && typeof node.id === "string" && typeof node.name === "string"
            ? [
                  {
                      id: node.id,
                      name: node.name,
                      exit: node.exit === "tor" ? "tor" : "direct",
                      browser: node.browser === true,
                      browserIssue:
                          node.browser === true ? null : browserIssueOf(node.browserIssue),
                      country: countryCode(typeof node.country === "string" ? node.country : null),
                      city:
                          typeof node.city === "string" && node.city.trim()
                              ? node.city.trim().slice(0, 120)
                              : null
                  }
              ]
            : []
    );
}

/** A start time worth showing: a past instant, never one from a broken clock. */
export function sinceOf(route: VpnRoute | null, now: number): number | null {
    const since = route?.since;
    return typeof since === "number" && Number.isFinite(since) && since > 0 && since <= now + 60_000
        ? since
        : null;
}

function readLogin(value: unknown): (VpnLogin & { host: string; port: number }) | null {
    if (!isObject(value)) return null;
    const { username, password, expiresAt, host, port } = value;
    return typeof username === "string" &&
        typeof password === "string" &&
        typeof expiresAt === "number" &&
        typeof host === "string" &&
        typeof port === "number"
        ? { username, password, expiresAt, host, port }
        : null;
}

export class BrowserVpn {
    private readonly tries = new Map<string, number>();
    /** The renewal under way, shared by the many requests of one page. */
    private renewing: Promise<VpnLogin | null> | null = null;

    constructor(private readonly deps: VpnDeps) {}

    private send(address: string, init: RequestInit): Promise<Response | null> {
        const send = this.deps.fetch ?? fetch;
        return send(address, {
            ...init,
            credentials: "omit",
            signal: AbortSignal.timeout(TIMEOUT_MS)
        }).catch(() => null);
    }

    private nowSeconds(): number {
        return Math.floor((this.deps.now ?? Date.now)() / 1000);
    }

    /** Asks the server for a login. Null when the answer was not one. */
    private async fetchLogin(
        nodeId: string
    ): Promise<{ login: ReturnType<typeof readLogin>; refused: VpnRefusal | null }> {
        const { origin, token } = await this.deps.link();
        if (!origin || !token) return { login: null, refused: "noAccess" };
        const reply = await this.send(`${origin}/api/extension/vpn/login`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ nodeId })
        });
        if (reply === null) return { login: null, refused: "unreachable" };
        if (reply.ok) {
            const login = readLogin(await reply.json().catch(() => null));
            return login ? { login, refused: null } : { login: null, refused: "unreachable" };
        }
        if ([401, 403, 404].includes(reply.status)) return { login: null, refused: "noAccess" };
        return { login: null, refused: reply.status === 503 ? "notReady" : "unreachable" };
    }

    /**
     * The login to answer the proxy with. Somebody who lost access is taken off
     * the proxy rather than left with a browser that reaches nothing.
     */
    private async currentLogin(fresh: boolean): Promise<VpnLogin | null> {
        const route = await this.deps.route.getValue();
        if (!route) return null;
        const held = await this.deps.login.getValue();
        if (!fresh && held && held.expiresAt - LOGIN_MARGIN_SECONDS > this.nowSeconds())
            return held;
        this.renewing ??= this.renewLogin(route.nodeId).finally(() => {
            this.renewing = null;
        });
        return this.renewing;
    }

    private async renewLogin(nodeId: string): Promise<VpnLogin | null> {
        const { login, refused } = await this.fetchLogin(nodeId);
        if (login) {
            await this.deps.login.setValue(login);
            return login;
        }
        if (refused === "noAccess") await this.disconnect();
        return null;
    }

    /** Chromium's question from the proxy. Everything else keeps its own prompt. */
    private answerAuth(details: AuthDetails, callback: (answer: AuthAnswer) => void): void {
        void (async () => {
            const route = await this.deps.route.getValue();
            if (!details.isProxy || !route || details.challenger?.host !== route.host) {
                return callback({});
            }
            const tried = (this.tries.get(details.requestId) ?? 0) + 1;
            this.tries.set(details.requestId, tried);
            if (this.tries.size > 500) this.tries.clear();
            if (tried > AUTH_TRIES) return callback({ cancel: true });
            const login = await this.currentLogin(tried > 1);
            callback(
                login
                    ? { authCredentials: { username: login.username, password: login.password } }
                    : { cancel: true }
            );
        })().catch(() => callback({ cancel: true }));
    }

    /**
     * Firefox's question, once per request. Only an ended connection goes direct: a
     * login that could not be renewed must not leave on the address somebody chose
     * to hide while the toolbar still says VPN.
     */
    private async answerRequest(info: { url: string }): Promise<unknown> {
        const direct = { type: "direct" };
        const route = await this.deps.route.getValue();
        if (!route || staysOutside(info.url, await this.deps.origins())) return direct;
        const login = await this.currentLogin(false);
        if (!login) return (await this.deps.route.getValue()) ? NO_WAY_OUT : direct;
        return {
            type: "https",
            host: route.host,
            port: route.port,
            proxyAuthorizationHeader: `Basic ${btoa(`${login.username}:${login.password}`)}`
        };
    }

    /**
     * Listeners have to exist before the worker's first event, so this runs at its
     * top. A browser that refuses one loses the VPN, never the rest of the worker.
     */
    listen(): void {
        const { api } = this.deps;
        const all = { urls: ["<all_urls>"] };
        try {
            if (this.deps.perRequest) {
                api.proxy?.onRequest?.addListener((info) => this.answerRequest(info), all);
                api.permissions?.onRemoved?.addListener(({ origins }) => {
                    if (origins?.some((origin) => EVERY_SITE.some((site) => site === origin))) {
                        void this.disconnectIfConnected();
                    }
                });
                return;
            }
            api.webRequest?.onAuthRequired?.addListener(
                (details, callback) => this.answerAuth(details, callback),
                all,
                ["asyncBlocking"]
            );
            // Another extension let go of the proxy (turned off, removed): a
            // connection it had taken over gets the proxy back without a press.
            // After the sign-in listener, so a browser refusing this one still
            // answers the proxy's login.
            api.proxy?.settings?.onChange?.addListener(({ levelOfControl }) => {
                if (levelOfControl === "controllable_by_this_extension") void this.reclaim();
            });
        } catch (error) {
            console.warn("polaris: the VPN cannot listen in this browser:", error);
        }
    }

    async isConnected(): Promise<boolean> {
        return (await this.deps.route.getValue()) !== null;
    }

    async state(): Promise<VpnState> {
        const route = await this.deps.route.getValue();
        const active = route
            ? {
                  nodeId: route.nodeId,
                  nodeName: route.nodeName,
                  since: sinceOf(route, (this.deps.now ?? Date.now)())
              }
            : null;
        const webRtcGuard = this.deps.api.privacy?.network?.webRTCIPHandlingPolicy
            ? await this.deps.webRtcGuard.getValue().catch(() => true)
            : null;
        const conflict = await this.conflict();
        const { origin, token } = await this.deps.link();
        const none = { available: false, nodes: [], active, webRtcGuard, conflict };
        if (!origin || !token) return none;
        const reply = await this.send(`${origin}/api/extension/vpn`, {
            headers: { authorization: `Bearer ${token}` }
        });
        if (!reply?.ok) return none;
        const nodes = readNodes(await reply.json().catch(() => null));
        return { available: nodes.length > 0, nodes, active, webRtcGuard, conflict };
    }

    /** Who holds the proxy instead of Polaris, on Chromium. */
    async conflict(): Promise<ProxyConflict | null> {
        const settings = this.deps.api.proxy?.settings;
        if (this.deps.perRequest || !settings) return null;
        const held = await settings.get({}).catch(() => null);
        const level = held?.levelOfControl;
        if (level !== "controlled_by_other_extensions")
            return proxyConflict(level, null, undefined);
        return proxyConflict(level, await this.extensions(), this.deps.selfId);
    }

    /** The installed extensions, or null while the permission to list them is not granted. */
    private async extensions(): Promise<ManagedExtension[] | null> {
        const { management, permissions } = this.deps.api;
        if (!management?.getAll || !permissions) return null;
        const granted = await permissions
            .contains({ permissions: ["management"] })
            .catch(() => false);
        if (!granted) return null;
        return management.getAll().catch(() => null);
    }

    /**
     * Sets the proxy again for the connection in place, once whatever held it has
     * let go. Nothing to do while disconnected.
     */
    async reclaim(): Promise<VpnOutcome> {
        const route = await this.deps.route.getValue();
        if (!route) return { ok: true };
        const refused = await this.applyProxy(route).catch((): VpnRefusal => "blocked");
        if (refused) return { ok: false, code: refused };
        // A disconnect that landed while the proxy was being set has already
        // cleared it: setting it after that would hold the browser to a server
        // with no login to answer it with.
        if (!(await this.deps.route.getValue())) {
            await this.deps.api.proxy?.settings?.clear({ scope: "regular" }).catch(() => undefined);
            return { ok: true };
        }
        await this.guardWebRtc(true);
        await this.deps.changed();
        return { ok: true };
    }

    /**
     * Stops WebRTC from reaching out past the proxy and naming the real address,
     * while connected and the setting is on; lets it go otherwise.
     */
    private async guardWebRtc(connected: boolean): Promise<void> {
        const policy = this.deps.api.privacy?.network?.webRTCIPHandlingPolicy;
        if (!policy) return;
        const hold =
            connected && (await this.deps.webRtcGuard.getValue().catch(() => true)) !== false;
        await (
            hold
                ? policy.set({ value: "disable_non_proxied_udp", scope: "regular" })
                : policy.clear({ scope: "regular" })
        ).catch(() => undefined);
    }

    /** The setting, kept and applied at once to a connection already up. */
    async setWebRtcGuard(on: boolean): Promise<void> {
        await this.deps.webRtcGuard.setValue(on);
        if (await this.isConnected()) await this.guardWebRtc(true);
    }

    /** Null once the proxy is Polaris's, or why it cannot be. */
    private async applyProxy(route: VpnRoute): Promise<VpnRefusal | null> {
        const settings = this.deps.api.proxy?.settings;
        if (this.deps.perRequest || !settings) return null;
        const held = await settings.get({}).catch(() => null);
        const refused = refusalOf(held?.levelOfControl);
        if (refused) return refused;
        await settings.set({
            scope: "regular",
            value: {
                mode: "fixed_servers",
                rules: {
                    singleProxy: { scheme: "https", host: route.host, port: route.port },
                    bypassList: bypassList(await this.deps.origins())
                }
            }
        });
        return null;
    }

    private async mayReachEverySite(): Promise<boolean> {
        const { permissions } = this.deps.api;
        if (!permissions) return false;
        return permissions.contains({ origins: [...EVERY_SITE] }).catch(() => false);
    }

    /** The server's own answer through the proxy, then a site past it. */
    private async trafficFlows(): Promise<boolean> {
        const proof = await this.send(PROOF_URL, { cache: "no-store" });
        if (proof?.status !== 204) return false;
        return (await this.send(PROBE_URL, { mode: "no-cors", cache: "no-store" })) !== null;
    }

    /** Connected means traffic came back through the server, so that is tried first. */
    async connect(node: Pick<VpnNode, "id" | "name">): Promise<VpnOutcome> {
        if (!(await this.mayReachEverySite())) return { ok: false, code: "noSites" };
        const { origin } = await this.deps.link();
        const { login, refused } = await this.fetchLogin(node.id);
        if (!origin || !login) return { ok: false, code: refused ?? "unreachable" };
        const { host, port, ...held } = login;
        const since = (this.deps.now ?? Date.now)();
        const route = { origin, nodeId: node.id, nodeName: node.name, host, port, since };
        const previous = await this.deps.route.getValue();
        await this.deps.login.setValue(held);
        await this.deps.route.setValue(route);
        const taken = await this.applyProxy(route);
        if (taken) {
            await this.deps.route.setValue(previous);
            return { ok: false, code: taken };
        }
        await this.guardWebRtc(true);
        if (!(await this.trafficFlows())) {
            await this.disconnect();
            return { ok: false, code: "noTraffic" };
        }
        await this.deps.changed();
        return { ok: true };
    }

    private async disconnectIfConnected(): Promise<void> {
        if (await this.isConnected()) await this.disconnect();
    }

    async disconnect(): Promise<void> {
        await this.deps.route.setValue(null);
        await this.deps.login.setValue(null);
        await this.deps.api.proxy?.settings?.clear({ scope: "regular" }).catch(() => undefined);
        await this.guardWebRtc(false);
        await this.deps.changed();
    }
}
