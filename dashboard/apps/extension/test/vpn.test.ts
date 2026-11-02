import { describe, expect, it, vi } from "vitest";
import {
    BrowserVpn,
    bypassList,
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
const LOGIN = { username: "u.1", password: "p", expiresAt: NOW + 3600, host: "vpn.example.com", port: 443 };

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
    options: { perRequest?: boolean; send?: typeof fetch; control?: string; everySite?: boolean } = {}
) {
    const route = stored<VpnRoute | null>(null);
    const login = stored<VpnLogin | null>(null);
    const settings = {
        set: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
        get: vi.fn(async () => ({ levelOfControl: options.control ?? "controllable_by_this_extension" }))
    };
    const webRtc = { set: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    let auth: Listener = () => undefined;
    let request: (info: { url: string }) => Promise<unknown> = async () => undefined;
    let removed: (detail: { origins?: string[] }) => void = () => undefined;
    const permissions = {
        contains: vi.fn(async () => options.everySite ?? true),
        onRemoved: { addListener: (listener: typeof removed) => (removed = listener) }
    };
    const api = {
        permissions,
        proxy: { settings, onRequest: { addListener: (listener: typeof request) => (request = listener) } },
        webRequest: { onAuthRequired: { addListener: (listener: Listener) => (auth = listener) } },
        privacy: { network: { webRTCIPHandlingPolicy: webRtc } }
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
        link: async () => ({ origin: ORIGIN, token: "token" }),
        origins: async () => [ORIGIN],
        changed,
        perRequest: options.perRequest ?? false,
        fetch: send,
        now: () => NOW * 1000
    };
    const vpn = new BrowserVpn(deps);
    vpn.listen();
    return {
        vpn,
        route,
        login,
        settings,
        webRtc,
        changed,
        send,
        ask: (details: object) => new Promise<object>((resolve) => auth(details, resolve)),
        decide: (url: string) => request({ url }),
        lose: (origins: string[]) => removed({ origins })
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
            readNodes({ nodes: [{ id: "a", name: "A", exit: "x", browser: true }, { id: 1 }, null] })
        ).toEqual([{ id: "a", name: "A", exit: "direct", browser: true }]);
        expect(readNodes(null)).toEqual([]);
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
        expect(webRtc.set).toHaveBeenCalledWith({ value: "disable_non_proxied_udp", scope: "regular" });
        expect(route.box.value?.nodeName).toBe("Madrid");
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
    const challenge = { requestId: "1", isProxy: true, challenger: { host: "vpn.example.com", port: 443 } };

    it("leaves a website's own login prompt alone", async () => {
        const { vpn, ask } = harness();
        await vpn.connect(NODE);
        expect(await ask({ requestId: "2", isProxy: false })).toEqual({});
        expect(await ask({ requestId: "3", isProxy: true, challenger: { host: "other", port: 1 } })).toEqual({});
    });

    it("answers with the held login", async () => {
        const { vpn, ask } = harness();
        await vpn.connect(NODE);
        expect(await ask(challenge)).toEqual({ authCredentials: { username: "u.1", password: "p" } });
    });

    it("fetches a new login when the held one ran out", async () => {
        const { vpn, ask, login, send } = harness();
        await vpn.connect(NODE);
        login.box.value = { username: "old", password: "old", expiresAt: NOW - 1 };
        vi.mocked(send).mockClear();
        expect(await ask(challenge)).toEqual({ authCredentials: { username: "u.1", password: "p" } });
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
        const send = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
        const { vpn } = harness({ send });
        expect(await vpn.state()).toEqual({ available: false, nodes: [], active: null });
    });

    it("still names the active server when the list cannot be read", async () => {
        const { vpn, route } = harness({
            send: vi.fn(async () => {
                throw new Error("offline");
            }) as unknown as typeof fetch
        });
        route.box.value = { origin: ORIGIN, nodeId: "n", nodeName: "Madrid", host: "h", port: 443 };
        expect((await vpn.state()).active).toEqual({ nodeId: "n", nodeName: "Madrid" });
    });
});
