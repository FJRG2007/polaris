import { describe, expect, it, vi } from "vitest";
import {
    BrowserVpn,
    bypassList,
    proxyConflict,
    type ManagedExtension,
    readNodes,
    staysOutside,
    type VpnApi,
    type VpnDeps,
    type VpnLogin,
    type VpnRoute
} from "@/lib/vpn";

const ORIGIN = "https://polaris.example.com";
const NODE = { id: "node-1", name: "Madrid" };
const NOW = 1_800_000_000;
const LOGIN = {
    username: "u.1",
    password: "p",
    expiresAt: NOW + 3600,
    host: "vpn.example.com",
    port: 443
};

function stored<T>(value: T) {
    const box = { value };
    return {
        box,
        getValue: async () => box.value,
        setValue: async (next: T) => {
            box.value = next;
        }
    };
}

type Listener = (details: object, callback: (answer: object) => void) => void;

function harness(
    options: {
        perRequest?: boolean;
        send?: typeof fetch;
        control?: string;
        everySite?: boolean;
        noPrivacy?: boolean;
        /** What `management.getAll` answers; no management API at all when missing. */
        extensions?: ManagedExtension[];
        /** Whether the optional `management` permission is granted. */
        management?: boolean;
    } = {}
) {
    const route = stored<VpnRoute | null>(null);
    const login = stored<VpnLogin | null>(null);
    // What the browser's storage hands back for a key never written: the fallback.
    const guard = stored<boolean>(true);
    const control = { level: options.control ?? "controllable_by_this_extension" };
    let changeProxy: (detail: { levelOfControl?: string }) => void = () => undefined;
    const settings = {
        set: vi.fn(async (_detail: object) => undefined),
        clear: vi.fn(async () => undefined),
        get: vi.fn(async () => ({ levelOfControl: control.level })),
        onChange: { addListener: (listener: typeof changeProxy) => (changeProxy = listener) }
    };
    const webRtc = { set: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    let auth: Listener = () => undefined;
    let request: (info: { url: string }) => Promise<unknown> = async () => undefined;
    let removed: (detail: { origins?: string[] }) => void = () => undefined;
    const permissions = {
        contains: vi.fn(async (detail: { origins?: string[]; permissions?: string[] }) =>
            detail.permissions ? (options.management ?? false) : (options.everySite ?? true)
        ),
        onRemoved: { addListener: (listener: typeof removed) => (removed = listener) }
    };
    const api = {
        permissions,
        proxy: {
            settings,
            onRequest: { addListener: (listener: typeof request) => (request = listener) }
        },
        webRequest: { onAuthRequired: { addListener: (listener: Listener) => (auth = listener) } },
        privacy: options.noPrivacy ? undefined : { network: { webRTCIPHandlingPolicy: webRtc } },
        management: options.extensions
            ? { getAll: vi.fn(async () => options.extensions) }
            : undefined
    } as unknown as VpnApi;
    const send =
        options.send ??
        (vi.fn(async (address: string) => {
            if (address.includes("proof.invalid")) return new Response(null, { status: 204 });
            return address.includes("generate_204")
                ? new Response(null, { status: 200 })
                : Response.json(LOGIN);
        }) as unknown as typeof fetch);
    const changed = vi.fn();
    const deps: VpnDeps = {
        api,
        route,
        login,
        webRtcGuard: guard,
        link: async () => ({ origin: ORIGIN, token: "token" }),
        origins: async () => [ORIGIN],
        changed,
        perRequest: options.perRequest ?? false,
        fetch: send,
        now: () => NOW * 1000,
        selfId: "polaris-self"
    };
    const vpn = new BrowserVpn(deps);
    vpn.listen();
    return {
        vpn,
        route,
        login,
        settings,
        webRtc,
        guard,
        changed,
        send,
        ask: (details: object) => new Promise<object>((resolve) => auth(details, resolve)),
        decide: (url: string) => request({ url }),
        lose: (origins: string[]) => removed({ origins }),
        control,
        /** The browser saying the proxy setting changed hands. */
        proxyChanged: (level: string) => {
            control.level = level;
            changeProxy({ levelOfControl: level });
        }
    };
}

describe("what stays outside the tunnel", () => {
    it("keeps Polaris and local addresses out on Chromium", () => {
        const list = bypassList([ORIGIN, "bad address"]);
        expect(list).toContain("polaris.example.com");
        expect(list).toContain("<local>");
        expect(list).toContain("192.168.0.0/16");
    });

    it("applies the same rule request by request", () => {
        expect(staysOutside(`${ORIGIN}/api/x`, [ORIGIN])).toBe(true);
        expect(staysOutside("http://192.168.1.4/", [])).toBe(true);
        expect(staysOutside("http://172.20.0.1/", [])).toBe(true);
        expect(staysOutside("http://printer.local/", [])).toBe(true);
        expect(staysOutside("http://nas/", [])).toBe(true);
        expect(staysOutside("https://example.org/", [ORIGIN])).toBe(false);
        expect(staysOutside("http://172.32.0.1/", [])).toBe(false);
    });
});

describe("readNodes", () => {
    it("drops what is not a server and reads an unknown exit as direct", () => {
        expect(
            readNodes({
                nodes: [{ id: "a", name: "A", exit: "x", browser: true }, { id: 1 }, null]
            })
        ).toEqual([
            {
                id: "a",
                name: "A",
                exit: "direct",
                browser: true,
                browserIssue: null,
                country: null,
                city: null
            }
        ]);
        expect(readNodes(null)).toEqual([]);
    });

    it("keeps why a server is not for browsers, and nothing it does not know", () => {
        expect(
            readNodes({
                nodes: [
                    { id: "a", name: "A", browser: false, browserIssue: "edge" },
                    { id: "b", name: "B", browser: false, browserIssue: "other" },
                    { id: "c", name: "C", browser: false },
                    { id: "d", name: "D", browser: true, browserIssue: "address" }
                ]
            }).map((node) => node.browserIssue)
        ).toEqual(["edge", null, null, null]);
    });

    it("reads where a server is, and nothing where an older host says nothing", () => {
        const [placed, bare, odd] = readNodes({
            nodes: [
                { id: "a", name: "A", browser: true, country: "es", city: " Madrid " },
                { id: "b", name: "B", browser: true },
                { id: "c", name: "C", browser: true, country: "Spain", city: "  " }
            ]
        });
        expect([placed?.country, placed?.city]).toEqual(["ES", "Madrid"]);
        expect([bare?.country, bare?.city]).toEqual([null, null]);
        expect([odd?.country, odd?.city]).toEqual([null, null]);
    });
});

describe("connecting on Chromium", () => {
    it("sets a secure proxy, guards WebRTC and checks traffic flows", async () => {
        const { vpn, settings, webRtc, route, login, changed, send } = harness();
        expect(await vpn.connect(NODE)).toEqual({ ok: true });
        expect(settings.set).toHaveBeenCalledWith({
            scope: "regular",
            value: {
                mode: "fixed_servers",
                rules: {
                    singleProxy: { scheme: "https", host: "vpn.example.com", port: 443 },
                    bypassList: bypassList([ORIGIN])
                }
            }
        });
        expect(webRtc.set).toHaveBeenCalledWith({
            value: "disable_non_proxied_udp",
            scope: "regular"
        });
        expect(route.box.value?.nodeName).toBe("Madrid");
        expect(route.box.value?.since).toBe(NOW * 1000);
        expect(login.box.value?.password).toBe("p");
        expect(login.box.value).not.toHaveProperty("host");
        expect(changed).toHaveBeenCalled();
        expect(vi.mocked(send).mock.calls.at(-1)?.[0]).toContain("generate_204");
    });

    it("takes everything back when no traffic comes through", async () => {
        const send = vi.fn(async (address: string) => {
            if (address.includes("proof.invalid")) return new Response(null, { status: 204 });
            if (address.includes("generate_204")) throw new Error("proxy failed");
            return Response.json(LOGIN);
        }) as unknown as typeof fetch;
        const { vpn, settings, webRtc, route, login } = harness({ send });
        expect(await vpn.connect(NODE)).toEqual({ ok: false, code: "noTraffic" });
        expect(route.box.value).toBeNull();
        expect(login.box.value).toBeNull();
        expect(settings.clear).toHaveBeenCalled();
        expect(webRtc.clear).toHaveBeenCalled();
    });

    it("will not call it connected when requests did not reach the proxy", async () => {
        const send = vi.fn(async (address: string) => {
            if (address.includes("proof.invalid")) throw new TypeError("no such name");
            return address.includes("generate_204") ? new Response(null) : Response.json(LOGIN);
        }) as unknown as typeof fetch;
        const { vpn, route } = harness({ perRequest: true, send });
        expect(await vpn.connect(NODE)).toEqual({ ok: false, code: "noTraffic" });
        expect(route.box.value).toBeNull();
    });

    it("asks for every site before anything else", async () => {
        const { vpn, send, route } = harness({ everySite: false });
        expect(await vpn.connect(NODE)).toEqual({ ok: false, code: "noSites" });
        expect(send).not.toHaveBeenCalled();
        expect(route.box.value).toBeNull();
    });

    it("refuses when another extension holds the proxy", async () => {
        const { vpn, settings, route } = harness({ control: "controlled_by_other_extensions" });
        expect(await vpn.connect(NODE)).toEqual({ ok: false, code: "blocked" });
        expect(settings.set).not.toHaveBeenCalled();
        expect(route.box.value).toBeNull();
    });

    it.each([
        [403, "noAccess"],
        [503, "notReady"],
        [500, "unreachable"]
    ])("says why a %i stopped it, touching nothing", async (status, code) => {
        const send = vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
        const { vpn, settings } = harness({ send });
        expect(await vpn.connect(NODE)).toEqual({ ok: false, code });
        expect(settings.set).not.toHaveBeenCalled();
    });
});

describe("the proxy asking for a login", () => {
    const challenge = {
        requestId: "1",
        isProxy: true,
        challenger: { host: "vpn.example.com", port: 443 }
    };

    it("leaves a website's own login prompt alone", async () => {
        const { vpn, ask } = harness();
        await vpn.connect(NODE);
        expect(await ask({ requestId: "2", isProxy: false })).toEqual({});
        expect(
            await ask({ requestId: "3", isProxy: true, challenger: { host: "other", port: 1 } })
        ).toEqual({});
    });

    it("answers with the held login", async () => {
        const { vpn, ask } = harness();
        await vpn.connect(NODE);
        expect(await ask(challenge)).toEqual({
            authCredentials: { username: "u.1", password: "p" }
        });
    });

    it("fetches a new login when the held one ran out", async () => {
        const { vpn, ask, login, send } = harness();
        await vpn.connect(NODE);
        login.box.value = { username: "old", password: "old", expiresAt: NOW - 1 };
        vi.mocked(send).mockClear();
        expect(await ask(challenge)).toEqual({
            authCredentials: { username: "u.1", password: "p" }
        });
        expect(send).toHaveBeenCalledOnce();
    });

    it("gives up on a request the proxy keeps refusing", async () => {
        const { vpn, ask } = harness();
        await vpn.connect(NODE);
        await ask(challenge);
        await ask(challenge);
        expect(await ask(challenge)).toEqual({ cancel: true });
    });

    it("takes the browser off the proxy once access is gone", async () => {
        let allowed = true;
        const send = vi.fn(async (address: string) => {
            if (address.includes("proof.invalid")) return new Response(null, { status: 204 });
            if (address.includes("generate_204")) return new Response(null);
            return allowed ? Response.json(LOGIN) : new Response("{}", { status: 403 });
        }) as unknown as typeof fetch;
        const { vpn, ask, login, route, settings } = harness({ send });
        await vpn.connect(NODE);
        allowed = false;
        login.box.value = { username: "old", password: "old", expiresAt: NOW - 1 };
        expect(await ask(challenge)).toEqual({ cancel: true });
        expect(route.box.value).toBeNull();
        expect(settings.clear).toHaveBeenCalled();
    });
});

describe("Firefox, request by request", () => {
    it("sends outside traffic through the proxy with the login on it", async () => {
        const { vpn, decide, settings } = harness({ perRequest: true });
        await vpn.connect(NODE);
        expect(settings.set).not.toHaveBeenCalled();
        expect(await decide("https://example.org/")).toEqual({
            type: "https",
            host: "vpn.example.com",
            port: 443,
            proxyAuthorizationHeader: `Basic ${btoa("u.1:p")}`
        });
        expect(await decide(`${ORIGIN}/x`)).toEqual({ type: "direct" });
    });

    it("goes direct while disconnected", async () => {
        const { decide } = harness({ perRequest: true });
        expect(await decide("https://example.org/")).toEqual({ type: "direct" });
    });
});

describe("Firefox when a login cannot be renewed", () => {
    function failing(status: number | null) {
        let up = true;
        const send = vi.fn(async (address: string) => {
            if (address.includes("proof.invalid")) return new Response(null, { status: 204 });
            if (address.includes("generate_204")) return new Response(null);
            if (up) return Response.json(LOGIN);
            if (status === null) throw new Error("offline");
            return new Response("{}", { status });
        }) as unknown as typeof fetch;
        return { send, fail: () => (up = false) };
    }

    it.each([[null], [500], [503]])("never goes direct on %s", async (status) => {
        const { send, fail } = failing(status);
        const { vpn, decide, login } = harness({ perRequest: true, send });
        await vpn.connect(NODE);
        fail();
        login.box.value = { username: "old", password: "old", expiresAt: NOW - 1 };
        expect(await decide("https://example.org/")).toEqual({
            type: "http",
            host: "127.0.0.1",
            port: 1
        });
    });

    it("goes direct once access is gone, which ends the connection", async () => {
        const { send, fail } = failing(403);
        const { vpn, decide, login, route } = harness({ perRequest: true, send });
        await vpn.connect(NODE);
        fail();
        login.box.value = { username: "old", password: "old", expiresAt: NOW - 1 };
        expect(await decide("https://example.org/")).toEqual({ type: "direct" });
        expect(route.box.value).toBeNull();
    });

    it("renews once for a page's many requests", async () => {
        const { vpn, decide, login, send } = harness({ perRequest: true });
        await vpn.connect(NODE);
        login.box.value = { username: "old", password: "old", expiresAt: NOW - 1 };
        vi.mocked(send).mockClear();
        await Promise.all([decide("https://a.example/"), decide("https://b.example/")]);
        expect(send).toHaveBeenCalledOnce();
    });

    it("disconnects when every site is taken away", async () => {
        const { vpn, route, lose } = harness({ perRequest: true });
        await vpn.connect(NODE);
        lose(["https://polaris.example.com/*"]);
        await vi.waitFor(() => expect(route.box.value).not.toBeNull());
        lose(["https://*/*"]);
        await vi.waitFor(() => expect(route.box.value).toBeNull());
    });
});

describe("state", () => {
    it("is unavailable on a Polaris too old to answer", async () => {
        const send = vi.fn(
            async () => new Response("", { status: 404 })
        ) as unknown as typeof fetch;
        const { vpn } = harness({ send });
        expect(await vpn.state()).toEqual({
            available: false,
            nodes: [],
            active: null,
            webRtcGuard: true,
            conflict: null
        });
    });

    it("still names the active server when the list cannot be read", async () => {
        const { vpn, route } = harness({
            send: vi.fn(async () => {
                throw new Error("offline");
            }) as unknown as typeof fetch
        });
        route.box.value = { origin: ORIGIN, nodeId: "n", nodeName: "Madrid", host: "h", port: 443 };
        expect((await vpn.state()).active).toEqual({
            nodeId: "n",
            nodeName: "Madrid",
            since: null
        });
    });

    it("says when it connected, and nothing for a route saved before that was kept", async () => {
        const { vpn, route } = harness();
        const saved = { origin: ORIGIN, nodeId: "n", nodeName: "Madrid", host: "h", port: 443 };
        route.box.value = { ...saved, since: NOW * 1000 - 720_000 };
        expect((await vpn.state()).active?.since).toBe(NOW * 1000 - 720_000);
        for (const since of [Number.NaN, 0, -5, NOW * 1000 + 3_600_000, "x" as unknown as number]) {
            route.box.value = { ...saved, since };
            expect((await vpn.state()).active?.since).toBeNull();
        }
    });

    it("hides the WebRTC setting where the browser cannot hold WebRTC", async () => {
        const { vpn } = harness({ noPrivacy: true });
        expect((await vpn.state()).webRtcGuard).toBeNull();
    });
});

describe("the WebRTC setting", () => {
    it("is on when nothing was ever chosen", async () => {
        const { vpn, webRtc } = harness();
        expect((await vpn.state()).webRtcGuard).toBe(true);
        await vpn.connect(NODE);
        expect(webRtc.set).toHaveBeenCalledWith({
            value: "disable_non_proxied_udp",
            scope: "regular"
        });
    });

    it("leaves WebRTC alone on connecting when it is off", async () => {
        const { vpn, webRtc, guard } = harness();
        guard.box.value = false;
        expect(await vpn.connect(NODE)).toEqual({ ok: true });
        expect(webRtc.set).not.toHaveBeenCalled();
        expect(webRtc.clear).toHaveBeenCalled();
        expect((await vpn.state()).webRtcGuard).toBe(false);
    });

    it("applies to a connection already up, without reconnecting", async () => {
        const { vpn, webRtc, guard, settings } = harness();
        await vpn.connect(NODE);
        const proxied = settings.set.mock.calls.length;
        webRtc.set.mockClear();
        await vpn.setWebRtcGuard(false);
        expect(guard.box.value).toBe(false);
        expect(webRtc.clear).toHaveBeenCalledWith({ scope: "regular" });
        await vpn.setWebRtcGuard(true);
        expect(webRtc.set).toHaveBeenCalledWith({
            value: "disable_non_proxied_udp",
            scope: "regular"
        });
        expect(settings.set.mock.calls.length).toBe(proxied);
    });

    it("is only kept while disconnected, and touches nothing", async () => {
        const { vpn, webRtc, guard } = harness();
        await vpn.setWebRtcGuard(false);
        await vpn.setWebRtcGuard(true);
        expect(guard.box.value).toBe(true);
        expect(webRtc.set).not.toHaveBeenCalled();
        expect(webRtc.clear).not.toHaveBeenCalled();
    });
});

const PROXY_TOOL: ManagedExtension = {
    id: "other-vpn",
    name: "Other VPN",
    enabled: true,
    type: "extension",
    permissions: ["proxy", "storage"],
    icons: [
        { size: 16, url: "chrome://extension-icon/other-vpn/16/0" },
        { size: 48, url: "chrome://extension-icon/other-vpn/48/0" },
        { size: 128, url: "chrome://extension-icon/other-vpn/128/0" }
    ],
    mayDisable: true
};

describe("who holds the proxy", () => {
    it("is nobody while Polaris may set it or already has", () => {
        expect(proxyConflict("controllable_by_this_extension", [PROXY_TOOL], "self")).toBeNull();
        expect(proxyConflict("controlled_by_this_extension", [PROXY_TOOL], "self")).toBeNull();
        expect(proxyConflict(undefined, null, "self")).toBeNull();
    });

    it("is the administrator under a policy, which no extension list changes", () => {
        expect(proxyConflict("not_controllable", [PROXY_TOOL], "self")).toEqual({
            kind: "policy"
        });
    });

    it("is unnamed while Polaris may not look at the extensions", () => {
        expect(proxyConflict("controlled_by_other_extensions", null, "self")).toEqual({
            kind: "extensions",
            extensions: null
        });
    });

    it("lists every enabled extension that may set a proxy, never Polaris itself", () => {
        const found = proxyConflict(
            "controlled_by_other_extensions",
            [
                PROXY_TOOL,
                { ...PROXY_TOOL, id: "self", name: "Polaris" },
                { ...PROXY_TOOL, id: "off", name: "Switched off", enabled: false },
                { ...PROXY_TOOL, id: "plain", name: "No proxy", permissions: ["storage"] },
                { ...PROXY_TOOL, id: "theme", name: "A theme", type: "theme" },
                {
                    id: "managed",
                    name: "Work proxy",
                    enabled: true,
                    permissions: ["proxy"],
                    mayDisable: false
                }
            ],
            "self"
        );
        expect(found).toEqual({
            kind: "extensions",
            extensions: [
                {
                    id: "other-vpn",
                    name: "Other VPN",
                    icon: "chrome://extension-icon/other-vpn/48/0",
                    mayDisable: true
                },
                { id: "managed", name: "Work proxy", icon: null, mayDisable: false }
            ]
        });
    });

    it("keeps the conflict, with nobody named, when no candidate is left", () => {
        expect(proxyConflict("controlled_by_other_extensions", [], "self")).toEqual({
            kind: "extensions",
            extensions: []
        });
    });
});

describe("the VPN's state with the proxy held elsewhere", () => {
    it("names the holder once the management permission is granted", async () => {
        const { vpn } = harness({
            control: "controlled_by_other_extensions",
            extensions: [PROXY_TOOL, { ...PROXY_TOOL, id: "polaris-self", name: "Polaris" }],
            management: true
        });
        expect((await vpn.state()).conflict).toEqual({
            kind: "extensions",
            extensions: [expect.objectContaining({ id: "other-vpn", name: "Other VPN" })]
        });
    });

    it("does not list the extensions without the permission", async () => {
        const { vpn } = harness({
            control: "controlled_by_other_extensions",
            extensions: [PROXY_TOOL],
            management: false
        });
        expect((await vpn.state()).conflict).toEqual({ kind: "extensions", extensions: null });
    });

    it("has no conflict on Firefox, which never competes for the setting", async () => {
        const { vpn } = harness({ perRequest: true, control: "controlled_by_other_extensions" });
        expect((await vpn.state()).conflict).toBeNull();
    });

    it("refuses to connect under a policy, naming the administrator", async () => {
        const { vpn, settings, route } = harness({ control: "not_controllable" });
        expect(await vpn.connect(NODE)).toEqual({ ok: false, code: "policy" });
        expect(settings.set).not.toHaveBeenCalled();
        expect(route.box.value).toBeNull();
    });
});

describe("taking the proxy back", () => {
    it("sets it again for the connection in place once the other extension lets go", async () => {
        const h = harness();
        expect(await h.vpn.connect(NODE)).toEqual({ ok: true });
        h.settings.set.mockClear();
        h.proxyChanged("controlled_by_other_extensions");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(h.settings.set).not.toHaveBeenCalled();
        h.proxyChanged("controllable_by_this_extension");
        await vi.waitFor(() => expect(h.settings.set).toHaveBeenCalledTimes(1));
        expect(h.settings.set.mock.calls[0]?.[0]).toMatchObject({
            value: { mode: "fixed_servers" }
        });
    });

    it("does nothing while disconnected", async () => {
        const h = harness();
        h.proxyChanged("controllable_by_this_extension");
        expect(await h.vpn.reclaim()).toEqual({ ok: true });
        expect(h.settings.set).not.toHaveBeenCalled();
    });

    it("leaves the proxy clear when a disconnect lands while it is being set", async () => {
        const h = harness();
        await h.vpn.connect(NODE);
        h.settings.clear.mockClear();
        h.settings.set.mockImplementationOnce(async () => {
            await h.vpn.disconnect();
            return undefined;
        });
        expect(await h.vpn.reclaim()).toEqual({ ok: true });
        expect(h.route.box.value).toBeNull();
        expect(h.settings.clear).toHaveBeenCalledTimes(2);
        expect(h.webRtc.set).toHaveBeenCalledTimes(1);
    });

    it("says it is still held when another extension took over next", async () => {
        const h = harness();
        await h.vpn.connect(NODE);
        h.control.level = "controlled_by_other_extensions";
        expect(await h.vpn.reclaim()).toEqual({ ok: false, code: "blocked" });
        expect(await h.vpn.isConnected()).toBe(true);
    });
});
