/**
 * What the Tunnels screen puts in front of the operator: the tunnel, the service
 * it reaches, and - until the first handshake - the provider firewall rule with
 * every value to type, since that rule is the one step Polaris cannot take.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TunnelView } from "@/lib/deploy/wireguard/tunnel-service";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../../../src/app/(app)/apps/tunnels/actions", () => ({
    createTunnelAction: vi.fn(),
    removeTunnelAction: vi.fn(),
    setTunnelPausedAction: vi.fn(),
    tunnelStatusesAction: vi.fn()
}));

const { FirewallStep, TunnelsView } = await import(
    "../../../src/app/(app)/apps/tunnels/tunnels-view"
);

const TUNNEL: TunnelView = {
    id: "0190a8c4-0000-7000-8000-000000000001",
    hostname: "app.example.com",
    listenPort: 51821,
    paused: false,
    publicServer: { id: "0190a8c4-0000-7000-8000-0000000000aa", name: "edge-1" },
    service: {
        id: "0190a8c4-0000-7000-8000-0000000000bb",
        name: "web",
        project: "Shop",
        server: "home-box"
    },
    endpointHost: "203.0.113.7",
    createdAt: "2026-10-01T00:00:00.000Z"
};

const OPTIONS = { servers: [], services: [] };

describe("the tunnels list", () => {
    it("names the hostname, the public server and port, and the service it reaches", () => {
        const markup = renderToStaticMarkup(
            withMessages(<TunnelsView tunnels={[TUNNEL]} options={OPTIONS} />)
        );
        expect(markup).toContain("app.example.com");
        expect(markup).toContain('href="https://app.example.com"');
        expect(markup).toContain("Through edge-1, UDP port 51821");
        expect(markup).toContain("web in Shop, on home-box");
        expect(markup).toContain('aria-label="Pause"');
        expect(markup).toContain('aria-label="Remove"');
        expect(markup).toContain("New tunnel");
    });

    it("offers resume rather than pause for a paused tunnel", () => {
        const markup = renderToStaticMarkup(
            withMessages(<TunnelsView tunnels={[{ ...TUNNEL, paused: true }]} options={OPTIONS} />)
        );
        expect(markup).toContain("Paused");
        expect(markup).toContain('aria-label="Resume"');
        expect(markup).not.toContain('aria-label="Refresh"');
    });

    it("says there are none, and still offers to make one", () => {
        const markup = renderToStaticMarkup(
            withMessages(<TunnelsView tunnels={[]} options={OPTIONS} />)
        );
        expect(markup).toContain("No tunnels yet");
        expect(markup).toContain("New tunnel");
    });
});

describe("the firewall step", () => {
    it("gives the protocol, port, source and address to type at the provider", () => {
        const markup = renderToStaticMarkup(withMessages(<FirewallStep tunnel={TUNNEL} />));
        expect(markup).toContain("Open UDP port 51821 on edge-1");
        expect(markup).toContain("UDP");
        expect(markup).toContain("51821");
        expect(markup).toContain("0.0.0.0/0");
        expect(markup).toContain("203.0.113.7");
        expect(markup).toContain("Point app.example.com at 203.0.113.7 with an A record");
    });

    it("asks for an AAAA record when the server's address is IPv6", () => {
        const markup = renderToStaticMarkup(
            withMessages(<FirewallStep tunnel={{ ...TUNNEL, endpointHost: "2001:db8::7" }} />)
        );
        expect(markup).toContain("Point app.example.com at 2001:db8::7 with an AAAA record");
    });

    it("says the address is not known rather than leaving a blank", () => {
        const markup = renderToStaticMarkup(
            withMessages(<FirewallStep tunnel={{ ...TUNNEL, endpointHost: null }} />)
        );
        expect(markup).toContain("Not known yet");
        expect(markup).not.toContain("Point app.example.com");
    });
});
