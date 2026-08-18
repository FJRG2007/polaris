/**
 * The call server's route at the edge.
 *
 * The one piece with no partial failure: without it every call dies at the first
 * WebSocket, before a microphone is opened and with nothing on screen to say
 * why. It cannot come from container labels - the media server runs on the
 * host's network and has no address on any Docker network to route to - so this
 * file is the whole of how a browser reaches it.
 *
 * The shape is asserted line by line rather than parsed, for the same reason the
 * dashboard's own route is: what is being protected is what Traefik is handed.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Where calls run, per case: nowhere at all, or somebody else's server. */
let endpoint: { url: string; shipped: boolean } | null = null;
vi.mock("@/lib/chat/call-server", () => ({ callServer: async () => endpoint }));
vi.mock("@/lib/domain-edge", () => ({ dashboardHosts: async () => [] }));
vi.mock("@/lib/waf-service", () => ({ resolvePolarisWaf: async () => ({ allowLists: [] }) }));

process.env.POLARIS_TRAEFIK_DYNAMIC_DIR = await mkdtemp(join(tmpdir(), "polaris-dynamic-"));

const { CALL_PATH, renderCallServerRoute, syncCallServerRoute } = await import(
    "@/lib/chat/call-edge"
);

beforeEach(() => {
    endpoint = null;
});

describe("the call server's route", () => {
    it("carries the path a browser is told to dial", () => {
        expect(renderCallServerRoute(true)).toContain(`rule: "PathPrefix(\`${CALL_PATH}\`)"`);
        // Above the dashboard's own host rules, which would otherwise take this
        // path: Traefik ranks by rule length when nothing says otherwise, and a
        // handful of hostnames easily outweighs one prefix.
        expect(renderCallServerRoute(true)).toContain("priority: 100");
    });

    it("takes the prefix back off, because the server serves from the root", () => {
        expect(renderCallServerRoute(true)).toContain("stripPrefix:");
        expect(renderCallServerRoute(true)).toContain(`- "${CALL_PATH}"`);
    });

    it("dials the host by name rather than by an address", () => {
        // An address is read once and stored, and the day the lease moves every
        // call gets a 502 with a perfectly healthy server behind it.
        expect(renderCallServerRoute(true)).toContain('url: "http://host.docker.internal:7880"');
    });

    it("names its middleware apart from everything else in that directory", () => {
        // The file provider merges every file it finds into one configuration, so
        // a name reused from the dashboard's route or an app's is a duplicate
        // definition - and a bad file freezes the whole edge on its last good
        // config, every deployed domain with it.
        expect(renderCallServerRoute(true)).toContain("polaris-livekit-strip:");
        expect(renderCallServerRoute(true)).toContain("middlewares: [polaris-livekit-strip]");
    });

    it("publishes nothing when calls run somewhere else", () => {
        // An instance pointed at a call server somebody else operates has no use
        // for this path, and one left behind reaches nothing.
        expect(renderCallServerRoute(false)).toBe("http: {}\n");
    });

    it("carries the firewall's allowlist onto the hostnames it covers", () => {
        const config = renderCallServerRoute(true, {
            hosts: ["polaris.example.com"],
            allow: ["203.0.113.0/24"]
        });
        // A path router matches every hostname and outranks the dashboard's own
        // route, so without this an instance firewalled to one office still
        // answered here from anywhere - stepping outside a restriction its
        // operator set on purpose.
        expect(config).toContain('rule: "(Host(`polaris.example.com`)) && PathPrefix(`/livekit`)"');
        expect(config).toContain("middlewares: [polaris-livekit-allow, polaris-livekit-strip]");
        expect(config).toContain('sourceRange: ["203.0.113.0/24"]');
        // Above the open one, which it has to outrank on those names.
        expect(config).toContain("priority: 110");
    });

    it("leaves the local names alone", () => {
        // The allowlist is about the public hostnames: the local ones are served
        // by the compose labels and have no rule of their own. A call between two
        // devices in the house has to keep working while the internet is shut
        // out, so the open router stays.
        const config = renderCallServerRoute(true, {
            hosts: ["polaris.example.com"],
            allow: ["203.0.113.0/24"]
        });
        expect(config).toContain(`rule: "PathPrefix(\`${CALL_PATH}\`)"`);
        expect(config).toContain("priority: 100");
    });

    it("adds nothing when no firewall rule was set", () => {
        // An empty allowlist is not a restriction, and rendering an empty
        // sourceRange would be one that refuses everybody.
        const config = renderCallServerRoute(true, { hosts: ["polaris.example.com"], allow: [] });
        expect(config).not.toContain("ipAllowList");
        expect(config).toBe(renderCallServerRoute(true));
    });
});

describe("publishing it", () => {
    it("reports the route as unsettled when the shipped server could not be prepared", async () => {
        // It writes an empty config either way, and the two reasons for that are
        // not the same answer. Called settled, this one takes the route away at
        // boot and nothing puts it back: startup only retries what reports back
        // as unwritten, so every call fails at the WebSocket on a deployment that
        // was one retry from working.
        expect(await syncCallServerRoute()).toBe(false);
        expect((await readFile(routeFile(), "utf8")).trim()).toBe("http: {}");
    });

    it("is settled when calls deliberately run somewhere else", async () => {
        endpoint = { url: "wss://calls.example.com", shipped: false };
        // Nothing to publish, and nothing missing either. Retrying this forever
        // would be a deployment knocking on its own edge for a path it does not
        // want.
        expect(await syncCallServerRoute()).toBe(true);
    });

    it("publishes the path for the server this stack runs", async () => {
        endpoint = { url: "/livekit", shipped: true };
        expect(await syncCallServerRoute()).toBe(true);
        expect(await readFile(routeFile(), "utf8")).toContain("polaris-livekit");
    });
});

/** The file the edge watches, wherever this suite pointed it. */
function routeFile(): string {
    return join(process.env.POLARIS_TRAEFIK_DYNAMIC_DIR!, "polaris-livekit.yml");
}
