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

/** A server this account may leave through. */
export interface VpnNode {
    readonly id: string;
    readonly name: string;
    /** "direct" or "tor". */
    readonly exit: string;
    /** False while the server has no address a browser can reach it by. */
    readonly browser: boolean;
}

export interface VpnRoute {
    readonly origin: string;
    readonly nodeId: string;
    readonly nodeName: string;
    readonly host: string;
    readonly port: number;
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
    readonly active: { readonly nodeId: string; readonly nodeName: string } | null;
}

export type VpnRefusal =
    | "noSites"
    | "noAccess"
    | "notReady"
    | "unreachable"
    | "blocked"
    | "noTraffic";

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
        readonly network?: { readonly webRTCIPHandlingPolicy?: Pick<ProxySetting, "set" | "clear"> };
    };
    readonly permissions?: {
        contains(detail: { origins: string[] }): Promise<boolean>;
        readonly onRemoved?: {
            addListener(listener: (removed: { origins?: string[] }) => void): void;
        };
    };
}

export interface VpnDeps {
    readonly api: VpnApi;
    readonly route: Stored<VpnRoute | null>;
    readonly login: Stored<VpnLogin | null>;
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
                      browser: node.browser === true
                  }
              ]
            : []
    );
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
        if (!fresh && held && held.expiresAt - LOGIN_MARGIN_SECONDS > this.nowSeconds()) return held;
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
        } catch (error) {
            console.warn("polaris: the VPN cannot listen in this browser:", error);
        }
    }

    async isConnected(): Promise<boolean> {
        return (await this.deps.route.getValue()) !== null;
    }

    async state(): Promise<VpnState> {
        const route = await this.deps.route.getValue();
        const active = route ? { nodeId: route.nodeId, nodeName: route.nodeName } : null;
        const { origin, token } = await this.deps.link();
        if (!origin || !token) return { available: false, nodes: [], active };
        const reply = await this.send(`${origin}/api/extension/vpn`, {
            headers: { authorization: `Bearer ${token}` }
        });
        if (!reply?.ok) return { available: false, nodes: [], active };
        const nodes = readNodes(await reply.json().catch(() => null));
        return { available: nodes.length > 0, nodes, active };
    }

    /** Stops WebRTC from reaching out past the proxy and naming the real address. */
    private async guardWebRtc(on: boolean): Promise<void> {
        const policy = this.deps.api.privacy?.network?.webRTCIPHandlingPolicy;
        if (!policy) return;
        await (on
            ? policy.set({ value: "disable_non_proxied_udp", scope: "regular" })
            : policy.clear({ scope: "regular" })
        ).catch(() => undefined);
    }

    private async applyProxy(route: VpnRoute): Promise<boolean> {
        const settings = this.deps.api.proxy?.settings;
        if (this.deps.perRequest || !settings) return true;
        const held = await settings.get({}).catch(() => null);
        if (held?.levelOfControl === "controlled_by_other_extensions") return false;
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
        return true;
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
        const route = { origin, nodeId: node.id, nodeName: node.name, host, port };
        const previous = await this.deps.route.getValue();
        await this.deps.login.setValue(held);
        await this.deps.route.setValue(route);
        if (!(await this.applyProxy(route))) {
            await this.deps.route.setValue(previous);
            return { ok: false, code: "blocked" };
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
