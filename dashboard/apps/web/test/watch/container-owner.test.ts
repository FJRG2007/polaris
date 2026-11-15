/**
 * Whose a container is on "What is using the CPU": an official app's container
 * is Polaris, a Code session is named by its session, the relay's helpers are
 * Polaris with what they do, and anything else says whether Polaris started it.
 */

import { describe, expect, it, vi } from "vitest";
import type { ContainerSummary } from "@polaris/docker";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/hostd-client", () => ({ HostdClient: class {} }));
vi.mock("@/lib/agents/agent-notices", () => ({
    polarSessionHref: (id: string) => `/polar?session=${id}`
}));

const { describeContainer } = await import("@/lib/watch/container-rows");
const { isPolarisPart, codeSessionId } = await import("@/lib/polaris-parts");
const { officialOwner } = await import("@/lib/official-app-projects");
const { relayProject } = await import("@/lib/backup-access/relay");

const CONNECTION = "local-docker";
const SESSION = "0193a4b2-7c1d-7e2f-8a3b-4c5d6e7f8091";

function container(overrides: Partial<ContainerSummary>): ContainerSummary {
    return {
        id: "c0ffee000000aaaa",
        name: "something",
        image: "busybox:1.37.0",
        state: "running",
        status: "Up 2 hours",
        composeProject: null,
        composeService: null,
        ...overrides
    };
}

const vpnEngine = container({
    name: "marketplace-vpn-control-server-1a2b",
    composeProject: "polaris-1a2b3c4d",
    composeService: "headscale"
});
const official = new Map([["polaris-1a2b3c4d", { owner: "vpn", install: "vpn-engine" }]]);

describe("official apps", () => {
    it("counts an official app's install as the app that owns it", () => {
        expect(officialOwner("vpn-engine")).toBe("vpn");
        expect(officialOwner("dns-blocker-engine")).toBe("dns-blocker");
    });

    it("leaves a game server to whoever made it", () => {
        expect(officialOwner("minecraft")).toBeNull();
        expect(officialOwner("game-servers")).toBeNull();
    });

    it("puts the VPN control server under Polaris, named VPN", () => {
        expect(isPolarisPart(vpnEngine, official)).toBe(true);
        const row = describeContainer(vpnEngine, CONNECTION, new Map(), {
            official,
            sessions: new Map()
        });
        expect(row.group).toBe("polaris");
        expect(row.label).toBe("VPN");
        expect(row.detail).toBeTruthy();
        expect(row.app).toEqual({ owner: "vpn", install: "vpn-engine" });
        expect(row.container).toBe("marketplace-vpn-control-server-1a2b");
    });

    it("wins over the Deploy service the install is", () => {
        const owners = new Map([
            [
                "polaris-1a2b3c4d",
                {
                    id: "app",
                    name: "VPN control server",
                    projectId: "p",
                    where: "Marketplace / Production",
                    source: "image" as const,
                    canOpen: true,
                    canRestart: true
                }
            ]
        ]);
        const row = describeContainer(vpnEngine, CONNECTION, owners, {
            official,
            sessions: new Map()
        });
        expect(row.group).toBe("polaris");
        expect(row.detail).not.toBe("Marketplace / Production");
    });

    it("is somebody's app without the install map", () => {
        expect(isPolarisPart(vpnEngine)).toBe(false);
    });
});

describe("Code sessions", () => {
    const box = container({
        name: `polaris-session-${SESSION}`,
        composeProject: `polaris-session-${SESSION}`,
        image: "node:24"
    });

    it("reads the session id from the project", () => {
        expect(codeSessionId(box)).toBe(SESSION);
        expect(codeSessionId(container({ name: "polaris-session-" }))).toBeNull();
    });

    it("names the session, its repository and owner, and links it when allowed", () => {
        const row = describeContainer(box, CONNECTION, new Map(), {
            official: new Map(),
            sessions: new Map([
                [
                    SESSION,
                    { title: "Fix login", repository: "acme/web", owner: "Ada", canOpen: true }
                ]
            ])
        });
        expect(row.group).toBe("sessions");
        expect(row.label).toBe("Fix login");
        expect(row.href).toBe(`/polar?session=${SESSION}`);
        expect(row.session).toEqual({ known: true, repository: "acme/web", owner: "Ada" });
        expect(row.container).toBe(`polaris-session-${SESSION}`);
    });

    it("does not link a session the reader may not open", () => {
        const row = describeContainer(box, CONNECTION, new Map(), {
            official: new Map(),
            sessions: new Map([
                [SESSION, { title: "Theirs", repository: null, owner: "Bo", canOpen: false }]
            ])
        });
        expect(row.href).toBeNull();
    });

    it("never puts the uuid first for a container with no row", () => {
        const row = describeContainer(box, CONNECTION, new Map());
        expect(row.label).toBe("Code session");
        expect(row.label).not.toContain(SESSION);
        expect(row.session?.known).toBe(false);
    });
});

describe("relay helpers", () => {
    it("counts both of the house end's containers as Polaris, said by what they do", () => {
        const project = relayProject("home");
        const link = container({ name: "wg-nat-000000bac-wg", composeProject: project });
        const ports = container({ name: "wg-nat-00000051de00-wg", composeProject: project });
        expect(isPolarisPart(link)).toBe(true);
        const linkRow = describeContainer(link, CONNECTION, new Map());
        const portsRow = describeContainer(ports, CONNECTION, new Map());
        expect(linkRow.group).toBe("polaris");
        expect(linkRow.part).toBe("relayLink");
        expect(portsRow.part).toBe("relayPorts");
    });
});

describe("unknown containers", () => {
    it("says a stranger's container was not started by Polaris", () => {
        const row = describeContainer(container({ name: "portainer" }), CONNECTION, new Map());
        expect(row.group).toBe("other");
        expect(row.origin).toBe("elsewhere");
    });

    it("says a Polaris project nothing claims was started by Polaris", () => {
        const row = describeContainer(
            container({ name: "gone", composeProject: "polaris-deadbeef" }),
            CONNECTION,
            new Map()
        );
        expect(row.origin).toBe("polaris");
    });
});
