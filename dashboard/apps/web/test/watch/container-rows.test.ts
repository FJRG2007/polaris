/**
 * What each running container is called on "What is holding the memory".
 *
 * The rows used to arrive with only a project and environment beside a size -
 * six services of one project all read "Marketplace / Production" - and the
 * ones with nothing to add beside them read as a size and nothing at all. These
 * pin the rule that replaced it: every row has a name on its first line, a
 * deployed service is called by its service name and keeps the engine's
 * container name to tell it from its neighbours, and a container nobody can
 * name is still called what the engine calls it.
 */

import { describe, expect, it, vi } from "vitest";
import type { ContainerStats, ContainerSummary } from "@polaris/docker";

// host-volumes is imported for its pure project-name helper only.
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/hostd-client", () => ({ HostdClient: class {} }));

const { containerParts, describeContainer, memoryLimit } =
    await import("@/lib/watch/container-rows");
type DeployedApp = import("@/lib/watch/container-rows").DeployedApp;

const GB = 1024 ** 3;
const MACHINE = 30 * GB;
const CONNECTION = "local-docker";

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

function stats(memUsage: number, memLimit = MACHINE): ContainerStats {
    return {
        cpuPercent: 1,
        memUsage,
        memLimit,
        memPercent: (memUsage / memLimit) * 100
    } as ContainerStats;
}

function app(overrides: Partial<DeployedApp> = {}): DeployedApp {
    return {
        id: "app-1",
        name: "vision-worker",
        projectId: "project-1",
        where: "Marketplace / Production",
        source: "image",
        canOpen: true,
        canRestart: true,
        ...overrides
    };
}

describe("naming a running container", () => {
    it("calls a deployed service by its name, places it, and keeps its container name", () => {
        const owners = new Map([["polaris-8a3fda63", app()]]);
        const row = describeContainer(
            container({
                name: "marketplace-vision-worker-8a3f",
                composeProject: "polaris-8a3fda63",
                composeService: "marketplace-vision-worker-8a3f"
            }),
            CONNECTION,
            owners
        );
        expect(row.label).toBe("vision-worker");
        expect(row.detail).toBe("Marketplace / Production");
        expect(row.container).toBe("marketplace-vision-worker-8a3f");
        expect(row.group).toBe("apps");
        expect(row.href).toBe("/apps/deploy/project-1?service=app-1");
        expect(row.service).toEqual({ id: "app-1", source: "image", canRestart: true });
    });

    it("finds the service of a release-suffixed project and of its port sidecar", () => {
        const owners = new Map([["polaris-c69533f6", app({ name: "hmars" })]]);
        const sidecar = describeContainer(
            container({
                name: "hmars-hmars-c695-ba791a7-p80",
                composeProject: "polaris-c69533f6-ba791a7"
            }),
            CONNECTION,
            owners
        );
        expect(sidecar.label).toBe("hmars");
        expect(sidecar.container).toBe("hmars-hmars-c695-ba791a7-p80");
    });

    it("names a service the reader cannot open, but does not link it", () => {
        const owners = new Map([["polaris-8a3fda63", app({ canOpen: false, canRestart: false })]]);
        const row = describeContainer(
            container({ name: "x", composeProject: "polaris-8a3fda63" }),
            CONNECTION,
            owners
        );
        expect(row.label).toBe("vision-worker");
        expect(row.href).toBeNull();
        expect(row.service?.canRestart).toBe(false);
    });

    it("calls a part of Polaris by what it is, with its catalog key", () => {
        const row = describeContainer(
            container({
                name: "polaris-web-903",
                composeProject: "polaris",
                composeService: "web"
            }),
            CONNECTION,
            new Map()
        );
        expect(row.label).toBe("Dashboard");
        expect(row.part).toBe("web");
        expect(row.detail).toMatch(/control plane/);
        expect(row.group).toBe("polaris");
        expect(row.container).toBe("polaris-web-903");
    });

    it("still names a part of Polaris this release does not know", () => {
        const row = describeContainer(
            container({ name: "polaris-new-1", composeProject: "polaris", composeService: "new" }),
            CONNECTION,
            new Map()
        );
        expect(row.label).toBe("new");
        expect(row.part).toBeNull();
    });

    it("calls an unknown container by its container name and says what it runs", () => {
        const row = describeContainer(
            container({
                name: "wg-nat-000000bac-frp",
                image: "fatedier/frpc:v0.71.0",
                composeProject: "polaris-wg-nat-000000bac"
            }),
            CONNECTION,
            new Map()
        );
        expect(row.label).toBe("wg-nat-000000bac-frp");
        expect(row.image).toBe("fatedier/frpc:v0.71.0");
        expect(row.group).toBe("other");
        expect(row.href).toBe("/apps/containers/wg-nat-000000bac-frp?c=local-docker");
    });

    it("falls back to the engine id when a container has no name at all", () => {
        const row = describeContainer(container({ name: "" }), CONNECTION, new Map());
        expect(row.label).toBe("c0ffee000000");
    });
});

describe("the rows of a memory breakdown", () => {
    const running = [
        container({
            id: "a",
            name: "polaris-web-903",
            composeProject: "polaris",
            composeService: "web"
        }),
        container({ id: "b", name: "svc-1", composeProject: "polaris-8a3fda63" }),
        container({ id: "c", name: "svc-2", composeProject: "polaris-8a3fda63" }),
        container({
            id: "d",
            name: "qtunnel-e6babdc4",
            composeProject: "polaris-qtunnel-e6babdc4"
        }),
        container({ id: "e", name: "", composeProject: null }),
        container({ id: "f", name: "unsampled" })
    ];
    const samples = new Map<string, ContainerStats>([
        ["a", stats(2 * GB)],
        ["b", stats(GB, 2 * GB)],
        ["c", stats(100 * 1024 ** 2)],
        ["d", stats(20 * 1024 ** 2)],
        ["e", stats(8 * 1024 ** 2)]
    ]);
    const owners = new Map([["polaris-8a3fda63", app()]]);
    const rows = containerParts(running, samples, "mem", CONNECTION, owners, MACHINE);

    it("gives every row a name", () => {
        expect(rows).toHaveLength(5);
        for (const row of rows) expect(row.label.trim()).not.toBe("");
    });

    it("tells two services of one project apart by their container names", () => {
        const services = rows.filter((row) => row.group === "apps");
        expect(services.map((row) => row.container)).toEqual(["svc-1", "svc-2"]);
    });

    it("says a memory limit only where one is set", () => {
        expect(rows.find((row) => row.key === "b")?.limit).toBe(2 * GB);
        expect(rows.find((row) => row.key === "c")?.limit).toBeNull();
    });

    it("reads no limit for CPU", () => {
        const cpu = containerParts(running, samples, "cpu", CONNECTION, owners, null);
        expect(cpu.every((row) => row.limit === null)).toBe(true);
    });
});

describe("a container's memory limit", () => {
    it("is nothing when the engine reports the whole machine", () => {
        expect(memoryLimit(stats(GB), MACHINE)).toBeNull();
    });
    it("is the cap when one is set", () => {
        expect(memoryLimit(stats(GB, 4 * GB), MACHINE)).toBe(4 * GB);
    });
    it("is nothing when the machine's size is unknown", () => {
        expect(memoryLimit(stats(GB, 4 * GB), null)).toBeNull();
    });
});
