/**
 * The pure half of Tailscale remote access: what the component's status reads as,
 * which names the dashboard accepts, what the edge is asked to serve, and what the
 * operator is allowed to send.
 */

import { describe, expect, it } from "vitest";
import {
    authKeySchema,
    connectInputSchema,
    loginUrlFromLogs,
    parseStatus,
    renderServeConfig,
    renderTailscaleRoute,
    tailnetHost,
    togglesInputSchema
} from "@/lib/tailscale/tailscale-model";

const SITE = "${TS_CERT_DOMAIN}:443";

describe("parseStatus", () => {
    it("reads a connected machine", () => {
        const status = parseStatus(
            JSON.stringify({
                BackendState: "Running",
                Self: {
                    DNSName: "polaris.tail1234.ts.net.",
                    CapMap: { https: null, funnel: null }
                },
                CurrentTailnet: { Name: "fixture@example.test", MagicDNSSuffix: "tail1234.ts.net" },
                Peer: { a: {}, b: {} }
            })
        );
        expect(status).toEqual({
            state: "connected",
            loginUrl: null,
            host: "polaris.tail1234.ts.net",
            tailnet: "fixture@example.test",
            peers: 2,
            https: true,
            funnelAllowed: true
        });
    });

    it("reads a machine waiting for sign-in with its link", () => {
        const status = parseStatus(
            JSON.stringify({
                BackendState: "NeedsLogin",
                AuthURL: "https://login.tailscale.com/a/abc123"
            })
        );
        expect(status.state).toBe("needs-login");
        expect(status.loginUrl).toBe("https://login.tailscale.com/a/abc123");
        expect(status.host).toBeNull();
    });

    it("refuses a link that is not Tailscale's", () => {
        const status = parseStatus(
            JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://evil.example/a/abc" })
        );
        expect(status.loginUrl).toBeNull();
    });

    it("reports missing capabilities as unknown and absent ones as off", () => {
        const none = parseStatus(JSON.stringify({ BackendState: "Running", Self: {} }));
        expect(none.https).toBeNull();
        const off = parseStatus(
            JSON.stringify({ BackendState: "Running", Self: { Capabilities: ["other"] } })
        );
        expect(off.https).toBe(false);
        expect(off.funnelAllowed).toBe(false);
    });

    it("reads anything unparseable as still starting", () => {
        expect(parseStatus("").state).toBe("starting");
        expect(parseStatus("failed to connect to local tailscaled").state).toBe("starting");
        expect(parseStatus(JSON.stringify({ BackendState: "Stopped" })).state).toBe("stopped");
    });

    it("tolerates a warning line before the JSON", () => {
        const body = JSON.stringify({ BackendState: "Running", Self: { DNSName: "a.b.ts.net." } });
        expect(parseStatus(`Warning: client version mismatch\n${body}`).host).toBe("a.b.ts.net");
    });
});

describe("loginUrlFromLogs", () => {
    it("takes the newest link", () => {
        const logs =
            "To authenticate, visit:\n\thttps://login.tailscale.com/a/old1\n...\n\thttps://login.tailscale.com/a/new2\n";
        expect(loginUrlFromLogs(logs)).toBe("https://login.tailscale.com/a/new2");
        expect(loginUrlFromLogs("nothing here")).toBeNull();
    });
});

describe("tailnetHost", () => {
    it("accepts only ts.net names", () => {
        expect(tailnetHost("Polaris.Tail1234.ts.net.")).toBe("polaris.tail1234.ts.net");
        expect(tailnetHost("polaris.example.com")).toBeNull();
        expect(tailnetHost("evil.ts.net.example.com")).toBeNull();
        expect(tailnetHost("a`) || Host(`x.ts.net")).toBeNull();
        expect(tailnetHost("")).toBeNull();
        expect(tailnetHost(null)).toBeNull();
    });
});

describe("renderServeConfig", () => {
    it("proxies the machine name to the edge, tailnet only by default", () => {
        const config = JSON.parse(renderServeConfig({ serve: true, funnel: false }));
        expect(config.TCP["443"].HTTPS).toBe(true);
        expect(config.Web[SITE].Handlers["/"].Proxy).toBe("https+insecure://traefik:443");
        expect(config.AllowFunnel[SITE]).toBe(false);
    });

    it("opens Funnel only when asked and serves nothing when Serve is off", () => {
        const funnel = JSON.parse(renderServeConfig({ serve: true, funnel: true }));
        expect(funnel.AllowFunnel[SITE]).toBe(true);
        expect(renderServeConfig({ serve: false, funnel: true })).toBe("{}");
    });

    it("is one line, so it can travel as an environment value", () => {
        expect(renderServeConfig({ serve: true, funnel: true })).not.toMatch(/[\x00-\x1f]/);
    });
});

describe("renderTailscaleRoute", () => {
    it("routes the tailnet name to the dashboard with an explicit priority and no resolver", () => {
        const yaml = renderTailscaleRoute("polaris.tail1234.ts.net", "http://web:3000");
        expect(yaml).toContain('rule: "Host(`polaris.tail1234.ts.net`)"');
        expect(yaml).toContain("priority: 50");
        expect(yaml).toContain("entryPoints: [websecure]");
        expect(yaml).toContain("tls: {}");
        expect(yaml).not.toContain("certResolver");
        expect(yaml).toContain('url: "http://web:3000"');
    });

    it("renders an empty config with no name or a name that is not a tailnet's", () => {
        expect(renderTailscaleRoute(null, "http://web:3000")).toBe("# No routes.\n");
        expect(renderTailscaleRoute("example.com", "http://web:3000")).toBe("# No routes.\n");
    });
});

describe("schemas", () => {
    it("accepts a Tailscale key, trimmed, and nothing else", () => {
        expect(authKeySchema.parse("  tskey-auth-kAbc123-XYZ789  ")).toBe(
            "tskey-auth-kAbc123-XYZ789"
        );
        expect(authKeySchema.safeParse("sk-not-a-key").success).toBe(false);
        expect(authKeySchema.safeParse("tskey-short").success).toBe(false);
        expect(authKeySchema.safeParse("tskey-auth-abc\ndef12345").success).toBe(false);
        expect(connectInputSchema.parse({ authKey: "" }).authKey).toBe("");
        expect(connectInputSchema.parse({}).authKey).toBeUndefined();
    });

    it("refuses Funnel without Serve", () => {
        expect(togglesInputSchema.safeParse({ serve: false, funnel: true }).success).toBe(false);
        expect(togglesInputSchema.safeParse({ serve: true, funnel: true }).success).toBe(true);
        expect(togglesInputSchema.safeParse({ serve: "yes", funnel: false }).success).toBe(false);
    });
});
