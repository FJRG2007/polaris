/**
 * What older uninstalls left on the machine: detection is a pure function over
 * what the machine lists and what Polaris holds, so these cases are the whole
 * of the decision about what a clean-up may remove. Nothing runs on a machine.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/hostd-client", () => ({ HostdClient: class {} }));
vi.mock("@/lib/deploy/service-networks", () => ({ wantedPrivateNetworks: async () => [] }));

const {
    findLeftovers,
    liveContainers,
    routeIdsIn
} = await import("@/lib/deploy/uninstall-leftovers");
const { leftByRemovedApp } = await import("@/lib/deploy/host-volumes");

const LIVE_APP = "polaris-0a1b2c3d";
const GONE_APP = "polaris-deadbeef";
const LIVE_DOMAIN = "00000000-0000-7000-8000-000000000001";
const GONE_DOMAIN = "00000000-0000-7000-8000-000000000002";
const NET_LIVE = "polaris-net-e0123456789";
const NET_GONE = "polaris-net-sabcdef0123";
const NET_SHARED = "polaris-net-nffffffffff";

function container(id: string, project: string | null, networks: string[] = []) {
    return {
        id,
        name: `name-${id}`,
        image: "example/image:1",
        project,
        running: false,
        status: "Exited (0)",
        createdAt: null,
        networks
    };
}

const known = {
    appProjects: new Set([LIVE_APP]),
    wantedNetworks: new Set([NET_LIVE]),
    domainIds: new Set([LIVE_DOMAIN])
};

describe("findLeftovers", () => {
    it("names only what a removed application left", () => {
        const found = findLeftovers(
            {
                containers: [
                    container("a", LIVE_APP, [NET_LIVE]),
                    container("b", `${LIVE_APP}-r2`),
                    container("c", GONE_APP, [NET_GONE]),
                    container("d", `${GONE_APP}-r2`),
                    container("e", "polaris"),
                    container("f", "polaris-ntunnel-deadbeef"),
                    container("g", null)
                ],
                networks: [NET_LIVE, NET_GONE, "bridge", "polaris-proxy"],
                dirs: [LIVE_APP, GONE_APP, `${GONE_APP}-r2`],
                routes: [LIVE_DOMAIN, GONE_DOMAIN, "qtunnel-0a1b2c3d", "qtunnel-deadbeef"]
            },
            known
        );
        expect(found.containers.map((entry) => entry.id)).toEqual(["c", "d"]);
        expect(found.networks).toEqual([NET_GONE]);
        expect(found.dirs).toEqual([GONE_APP, `${GONE_APP}-r2`]);
        expect(found.routes).toEqual([GONE_DOMAIN, "qtunnel-deadbeef"]);
    });

    it("keeps a network something still uses or wants", () => {
        const found = findLeftovers(
            {
                // A container that is not leaving still sits on it.
                containers: [container("a", "someone-else", [NET_SHARED])],
                networks: [NET_SHARED, NET_LIVE],
                dirs: [],
                routes: []
            },
            known
        );
        expect(found.networks).toEqual([]);
    });

    it("offers nothing that depends on what could not be read", () => {
        const found = findLeftovers(
            {
                containers: [container("c", GONE_APP)],
                networks: [NET_GONE],
                dirs: null,
                routes: [GONE_DOMAIN]
            },
            { appProjects: new Set([LIVE_APP]), wantedNetworks: null, domainIds: null }
        );
        expect(found.networks).toEqual([]);
        expect(found.routes).toEqual([]);
        expect(found.dirs).toEqual([]);
        expect(found.containers).toHaveLength(1);
    });

    it("finds nothing on a clean machine", () => {
        const found = findLeftovers(
            {
                containers: [container("a", LIVE_APP, [NET_LIVE])],
                networks: [NET_LIVE],
                dirs: [LIVE_APP],
                routes: [LIVE_DOMAIN]
            },
            known
        );
        expect(found).toEqual({ containers: [], networks: [], dirs: [], routes: [] });
    });
});

describe("routeIdsIn", () => {
    it("reads each route id once, suffixes and services included", () => {
        const yaml = [
            "http:",
            "  routers:",
            `    polaris-app-${GONE_DOMAIN}:`,
            `    polaris-app-${GONE_DOMAIN}-redirect:`,
            "    polaris-app-qtunnel-deadbeef:",
            "    polaris-dashboard:",
            "  services:",
            `    polaris-app-${GONE_DOMAIN}-current:`
        ].join("\n");
        expect(routeIdsIn(yaml)).toEqual([GONE_DOMAIN, "qtunnel-deadbeef"]);
        expect(routeIdsIn("")).toEqual([]);
    });
});

describe("liveContainers", () => {
    it("reads project and networks from the daemon listing", () => {
        const [entry] = liveContainers([
            {
                Id: "abc",
                Names: ["/web-1"],
                State: "running",
                Labels: { "com.docker.compose.project": GONE_APP },
                NetworkSettings: { Networks: { [NET_GONE]: {} } }
            }
        ]);
        expect(entry).toMatchObject({
            id: "abc",
            name: "web-1",
            project: GONE_APP,
            running: true,
            networks: [NET_GONE]
        });
        expect(liveContainers([{ Names: ["/no-id"] }])).toEqual([]);
    });
});

describe("leftByRemovedApp", () => {
    it("marks a volume of an application Polaris no longer holds", () => {
        expect(leftByRemovedApp(GONE_APP, known.appProjects)).toBe(true);
        expect(leftByRemovedApp(`${GONE_APP}-r2`, known.appProjects)).toBe(true);
        expect(leftByRemovedApp(LIVE_APP, known.appProjects)).toBe(false);
        expect(leftByRemovedApp("polaris", known.appProjects)).toBe(false);
        expect(leftByRemovedApp(null, known.appProjects)).toBe(false);
    });
});
