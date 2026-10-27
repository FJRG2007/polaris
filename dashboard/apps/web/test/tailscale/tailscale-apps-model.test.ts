/**
 * The operator's apps on the tailnet: each routed hostname keeps one port, Funnel
 * only ever opens an app on a port it listens on, and what Serve and the edge are
 * told is rendered from that list alone.
 */

import { describe, expect, it } from "vitest";
import {
    allocateAppPorts,
    APP_PORT_FIRST,
    appUrl,
    holdsOnTailnet,
    renderServeConfig,
    renderTailscaleRoute,
    setAppPublic,
    tailnetAppHost,
    type TailnetApp
} from "@/lib/tailscale/tailscale-model";

const HOST = "polaris.tail1234.ts.net";
const COOKIES = "http://polaris-edge-guard:8080/tailnet-cookies";

function app(hostname: string, port: number, extra: Partial<TailnetApp> = {}): TailnetApp {
    return { hostname, port, public: false, live: true, ...extra };
}

describe("tailnetAppHost", () => {
    it("takes an exact name and refuses wildcards, tailnet names and junk", () => {
        expect(tailnetAppHost(" Shop.Example.com. ")).toBe("shop.example.com");
        expect(tailnetAppHost("*.example.com")).toBeNull();
        expect(tailnetAppHost("other.tail1234.ts.net")).toBeNull();
        expect(tailnetAppHost("localhost")).toBeNull();
        expect(tailnetAppHost('a"b.example.com')).toBeNull();
    });
});

describe("allocateAppPorts", () => {
    it("hands new names the lowest free ports in name order, whatever order they arrive in", () => {
        const one = allocateAppPorts([], ["b.example.com", "a.example.com"]);
        const two = allocateAppPorts([], ["a.example.com", "b.example.com"]);
        expect(one).toEqual(two);
        expect(one).toEqual([
            app("a.example.com", APP_PORT_FIRST),
            app("b.example.com", APP_PORT_FIRST + 1)
        ]);
    });

    it("keeps every port it already gave, and the port of a name that went away", () => {
        const first = allocateAppPorts([], ["a.example.com", "b.example.com"]);
        const gone = allocateAppPorts(first, ["b.example.com", "c.example.com"]);
        expect(gone).toEqual([
            app("a.example.com", APP_PORT_FIRST, { live: false }),
            app("b.example.com", APP_PORT_FIRST + 1),
            app("c.example.com", APP_PORT_FIRST + 2)
        ]);
        const back = allocateAppPorts(gone, ["a.example.com", "b.example.com", "c.example.com"]);
        expect(back.find((entry) => entry.hostname === "a.example.com")?.port).toBe(APP_PORT_FIRST);
    });

    it("is unchanged by a sync that routes the same names", () => {
        const first = allocateAppPorts([], ["a.example.com", "*.example.com", "a.example.com"]);
        expect(allocateAppPorts(first, ["a.example.com"])).toEqual(first);
        expect(first).toHaveLength(1);
    });

    it("reuses a gone name's port only once the range is full", () => {
        const full: TailnetApp[] = [];
        for (let port = APP_PORT_FIRST; port <= 10999; port++)
            full.push(app(`n${port}.example.com`, port, { live: port !== 10500 }));
        const names = full.filter((entry) => entry.live).map((entry) => entry.hostname);
        const next = allocateAppPorts(full, [...names, "new.example.com"]);
        expect(next.find((entry) => entry.hostname === "new.example.com")?.port).toBe(10500);
        expect(next.some((entry) => entry.hostname === "n10500.example.com")).toBe(false);
        expect(new Set(next.map((entry) => entry.port)).size).toBe(next.length);
    });
});

describe("setAppPublic", () => {
    it("moves an app to a Funnel port when opened and keeps it there when closed", () => {
        const opened = setAppPublic([app("a.example.com", 10001)], "a.example.com", true);
        expect(opened).toEqual({ apps: [app("a.example.com", 8443, { public: true })] });
        if (!("apps" in opened)) throw new Error("refused");
        const closed = setAppPublic(opened.apps, "a.example.com", false);
        expect(closed).toEqual({ apps: [app("a.example.com", 8443)] });
    });

    it("refuses a third public app and an unknown one", () => {
        const apps = [
            app("a.example.com", 8443, { public: true }),
            app("b.example.com", 10000, { public: true }),
            app("c.example.com", 10001)
        ];
        expect(setAppPublic(apps, "c.example.com", true)).toEqual({ refusal: "no-port" });
        expect(setAppPublic(apps, "z.example.com", true)).toEqual({ refusal: "unknown" });
    });

    it("takes a Funnel port from a name that is no longer routed", () => {
        const apps = [app("old.example.com", 8443, { live: false }), app("c.example.com", 10001)];
        const ports = [10000, 8443];
        const opened = setAppPublic(apps, "c.example.com", true);
        expect(
            "apps" in opened && opened.apps.find((e) => e.hostname === "c.example.com")?.port
        ).toBe(ports[0]);
        const busy = [
            app("old.example.com", 8443, { live: false }),
            app("b.example.com", 10000),
            app("c.example.com", 10001)
        ];
        const moved = setAppPublic(busy, "c.example.com", true);
        expect(moved).toEqual({
            apps: [app("b.example.com", 10000), app("c.example.com", 8443, { public: true })]
        });
    });
});

describe("renderServeConfig with apps", () => {
    it("gives each live app its own HTTPS port proxied to the edge under its path", () => {
        const config = JSON.parse(
            renderServeConfig({ serve: true, funnel: false }, [
                app("a.example.com", 10001),
                app("b.example.com", 8443, { public: true }),
                app("gone.example.com", 10002, { live: false })
            ])
        );
        expect(Object.keys(config.TCP).sort()).toEqual(["10001", "443", "8443"]);
        expect(config.Web["${TS_CERT_DOMAIN}:10001"].Handlers["/"].Proxy).toBe(
            "https+insecure://traefik:443/.polaris-ts/10001"
        );
        expect(config.AllowFunnel).toEqual({
            "${TS_CERT_DOMAIN}:443": false,
            "${TS_CERT_DOMAIN}:8443": true,
            "${TS_CERT_DOMAIN}:10001": false
        });
    });

    it("never opens a port Funnel does not listen on, and serves nothing with Serve off", () => {
        const config = JSON.parse(
            renderServeConfig({ serve: true, funnel: false }, [
                app("a.example.com", 10001, { public: true })
            ])
        );
        expect(config.AllowFunnel["${TS_CERT_DOMAIN}:10001"]).toBe(false);
        expect(
            renderServeConfig({ serve: false, funnel: false }, [app("a.example.com", 10001)])
        ).toBe("{}");
    });
});

describe("renderTailscaleRoute with apps", () => {
    const yaml = renderTailscaleRoute(
        HOST,
        "http://dashboard:3000",
        [app("a.example.com", 10001), app("b.example.com", 8443, { public: true })],
        COOKIES
    );

    it("routes each port's path back round the edge under the app's own name", () => {
        expect(yaml).toContain(
            'rule: "Host(`polaris.tail1234.ts.net`) && PathPrefix(`/.polaris-ts/10001/`) && !HeaderRegexp(`Tailscale-Funnel-Request`, `.`)"'
        );
        expect(yaml).toContain(
            'rule: "Host(`polaris.tail1234.ts.net`) && PathPrefix(`/.polaris-ts/8443/`)"'
        );
        expect(yaml).toContain("      priority: 60");
        expect(yaml).toContain('          - url: "https://traefik:443"');
        expect(yaml).toContain('      serverName: "a.example.com"');
        expect(yaml).toContain('        prefixes: ["/.polaris-ts/10001"]');
        expect(yaml).toContain('          Host: "a.example.com"');
        expect(yaml).toContain('          X-Forwarded-Prefix: ""');
        expect(yaml).toContain(
            "      middlewares: [polaris-tailscale-10001-cookies, polaris-tailscale-10001-strip, polaris-tailscale-10001-host]"
        );
    });

    it("hands each app only the cookies the guard leaves it", () => {
        expect(yaml).toContain(
            [
                "    polaris-tailscale-10001-cookies:",
                "      forwardAuth:",
                `        address: "${COOKIES}"`,
                "        authResponseHeaders: [Cookie]"
            ].join("\n")
        );
    });

    it("routes no app without the cookie filter", () => {
        expect(
            renderTailscaleRoute(HOST, "http://dashboard:3000", [app("a.example.com", 10001)])
        ).toBe(renderTailscaleRoute(HOST, "http://dashboard:3000"));
    });

    it("gives every router an explicit priority", () => {
        const routers = yaml.match(/^ {4}polaris-tailscale[\w-]*:\n {6}rule:/gm) ?? [];
        const ranked = yaml.match(/^ {6}priority: \d+$/gm) ?? [];
        expect(routers).toHaveLength(3);
        expect(ranked).toHaveLength(3);
    });

    it("leaves the machine's own route as it was when there are no apps", () => {
        expect(renderTailscaleRoute(HOST, "http://dashboard:3000", [])).toBe(
            renderTailscaleRoute(HOST, "http://dashboard:3000")
        );
        expect(renderTailscaleRoute(HOST, "http://dashboard:3000")).not.toContain("middlewares");
        expect(
            renderTailscaleRoute(
                null,
                "http://dashboard:3000",
                [app("a.example.com", 10001)],
                COOKIES
            )
        ).toBe("http: {}\n");
    });
});

describe("holdsOnTailnet", () => {
    const ipRule = (enabled: boolean) => ({
        enabled,
        conditions: [
            {
                match: "any" as const,
                conditions: [
                    { field: "ip" as const, operator: "equals" as const, values: ["1.2.3.4"] }
                ]
            }
        ]
    });

    it("keeps a route whose rules decide by neither address nor sign-in", () => {
        expect(holdsOnTailnet({})).toBe(true);
        expect(holdsOnTailnet({ allowLists: [[]], deny: [] })).toBe(true);
        expect(holdsOnTailnet({ rules: [ipRule(false)] })).toBe(true);
        expect(
            holdsOnTailnet({
                rules: [
                    {
                        enabled: true,
                        conditions: [{ field: "path", operator: "contains", values: ["/admin"] }]
                    }
                ]
            })
        ).toBe(true);
    });

    it("leaves off a route that asks for sign-in or reads the visitor's address", () => {
        expect(holdsOnTailnet({ requireLogin: true })).toBe(false);
        expect(holdsOnTailnet({ allowLists: [["10.0.0.0/8"]] })).toBe(false);
        expect(holdsOnTailnet({ deny: ["1.2.3.4"] })).toBe(false);
        expect(holdsOnTailnet({ rules: [ipRule(true)] })).toBe(false);
    });
});

describe("appUrl", () => {
    it("is the machine's name and the app's port, or null without a name", () => {
        expect(appUrl(HOST, 10001)).toBe("https://polaris.tail1234.ts.net:10001");
        expect(appUrl(null, 10001)).toBeNull();
    });
});
