/**
 * What the Containers table says about numbers it does not have yet, and about
 * numbers it has had for a while.
 *
 * Usage is sampled behind the request now, which means the listing paints before
 * any of it exists and, on a revisit, paints the readings the tab was holding
 * from last time. Both are improvements only if the screen is honest about them:
 * a container whose first sample is still coming must not read as idle, a host
 * total that is zero because nothing was measured must not read as zero load,
 * and a reading from minutes ago must say so instead of passing for live.
 *
 * Rendered to static markup - what is asserted is what the table puts on screen.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
    ContainerRow,
    HostSnapshot,
    OverviewData
} from "../../src/app/(app)/apps/containers/types";

let snapshot: HostSnapshot | null = null;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: snapshot,
        loading: snapshot === null,
        error: null,
        stale: null,
        refreshing: false,
        updatedAt: null,
        refresh: () => {}
    })
}));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [async () => true, null] }));
vi.mock("../../src/app/(app)/apps/containers/actions", () => ({
    containerAction: async () => ({}),
    removeContainerAction: async () => ({}),
    deleteDockerConnectionAction: async () => undefined
}));
vi.mock("../../src/app/(app)/apps/containers/docker-connection-dialog", () => ({
    DockerConnectionDialog: () => null
}));

const { ContainersView } = await import("../../src/app/(app)/apps/containers/containers-view");

const overview: OverviewData = {
    name: "lirio-0",
    serverVersion: "27.0.0",
    containers: 2,
    running: 1,
    stopped: 1,
    images: 12,
    ncpu: 16,
    memTotal: 32_000_000_000,
    aggregateCpuPercent: 0,
    aggregateMemUsage: 0
};

function row(overrides: Partial<ContainerRow> = {}): ContainerRow {
    return {
        id: "aaa111",
        name: "polaris-web",
        image: "ghcr.io/polaris/web:latest",
        state: "running",
        status: "Up 2 hours",
        cpuPercent: null,
        memUsage: null,
        memPercent: null,
        statsAt: null,
        ...overrides
    };
}

function render(value: HostSnapshot): string {
    snapshot = value;
    return renderToStaticMarkup(
        <ContainersView
            connections={[
                {
                    id: "local",
                    name: "Local host",
                    transport: "socket",
                    status: "active",
                    local: true
                }
            ]}
            connectionId="local"
            sshEnabled
            canManage
            localDiagnostic={null}
        />
    );
}

describe("containers table freshness", () => {
    it("says the first reading is on its way rather than reporting zero load", () => {
        const markup = render({
            overview,
            containers: [row(), row({ id: "bbb222", name: "polaris-old", state: "exited" })],
            canAttach: true,
            statsAt: null
        });

        expect(markup).toContain("first usage reading on its way");
        // The host totals are zero only because nothing has been measured, so
        // they are not shown as a figure at all.
        expect(markup).not.toContain("0%");
        expect(markup).toContain("16 cores");
    });

    it("shows a stopped container a dash and a running one that its number is coming", () => {
        const markup = render({
            overview,
            containers: [row(), row({ id: "bbb222", name: "polaris-old", state: "exited" })],
            canAttach: true,
            statsAt: null
        });

        const cells = markup.split("<td").filter((cell) => cell.includes("text-muted-foreground"));
        // The stopped row has nothing to read and says so; the running one has a
        // reading coming and shows it is waiting for it.
        expect(markup).toContain("-</td>");
        expect(
            cells.some((cell) => cell.includes("animate-pulse") || cell.includes("skeleton"))
        ).toBe(true);
    });

    it("reports live when the readings are seconds old", () => {
        const markup = render({
            overview: { ...overview, aggregateCpuPercent: 0.34, aggregateMemUsage: 273_700_000 },
            containers: [
                row({
                    cpuPercent: 0.34,
                    memUsage: 273_700_000,
                    memPercent: 0.87,
                    statsAt: Date.now()
                })
            ],
            canAttach: true,
            statsAt: Date.now() - 2_000
        });

        expect(markup).toContain("refreshing every 5s");
        expect(markup).toContain("0.34%");
    });

    it("says how old the readings are when they have aged", () => {
        const markup = render({
            overview: { ...overview, aggregateCpuPercent: 0.34, aggregateMemUsage: 273_700_000 },
            containers: [
                row({
                    cpuPercent: 0.34,
                    memUsage: 273_700_000,
                    memPercent: 0.87,
                    statsAt: Date.now() - 180_000
                })
            ],
            canAttach: true,
            statsAt: Date.now() - 180_000
        });

        expect(markup).toContain("usage from 3m ago");
        // The numbers stay on screen: an old reading is worth more than a blank,
        // as long as it is labelled.
        expect(markup).toContain("0.34%");
    });
});
