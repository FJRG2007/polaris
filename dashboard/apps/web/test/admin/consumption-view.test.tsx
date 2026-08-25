// @vitest-environment jsdom

/**
 * What the Consumption screen actually shows.
 *
 * The figures are settled elsewhere (see consumption.test.ts); this is about the
 * screen keeping its promises with them - a segment per group in the bar, a row
 * per thing with whose it is, the heaviest first, and an install that runs on
 * another server saying so instead of reading as idle.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Consumption, ConsumptionGroup, ConsumptionRow } from "@/app/(app)/admin/consumption/types";
import { ConsumptionGroupTable, ConsumptionSplit } from "@/app/(app)/admin/consumption/consumption-view";

/** Bytes are formatted in binary units, so the fixtures are round in those. */
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function row(overrides: Partial<ConsumptionRow> & { id: string; name: string }): ConsumptionRow {
    return {
        detail: "Minecraft",
        owner: "Ada",
        state: "running",
        stateLabel: "Running",
        containers: 1,
        cpuPercent: 3.5,
        memUsedBytes: GB,
        href: null,
        ...overrides
    };
}

function group(overrides: Partial<ConsumptionGroup> & { id: ConsumptionGroup["id"] }): ConsumptionGroup {
    return {
        label: "Marketplace apps",
        description: "Everything installed from the marketplace.",
        rows: [],
        containers: 0,
        running: 0,
        cpuPercent: 0,
        memUsedBytes: 0,
        ...overrides
    };
}

// Nothing here configures automatic cleanup, so a render left standing would be
// found by the next test's query.
afterEach(cleanup);

const CONSUMPTION: Consumption = {
    machine: { name: "lirio", ncpu: 8, memTotalBytes: 32 * GB },
    groups: [
        group({ id: "polaris", label: "Polaris itself", memUsedBytes: 1.5 * GB, containers: 6, running: 6, cpuPercent: 4 }),
        group({ id: "apps", memUsedBytes: 8 * GB, containers: 3, running: 2, cpuPercent: 22 }),
        group({ id: "services", label: "Deployed services", memUsedBytes: 0, containers: 0, running: 0, cpuPercent: 0 }),
        group({ id: "other", label: "Everything else", memUsedBytes: 400 * MB, containers: 1, running: 1, cpuPercent: 1 })
    ],
    sampledAt: Date.now() - 20_000,
    at: new Date().toISOString()
};

describe("the split at the top", () => {
    it("names the machine and says how much of it is in containers", () => {
        const { container } = render(<ConsumptionSplit consumption={CONSUMPTION} />);
        expect(screen.getByText("lirio")).toBeTruthy();
        expect(container.textContent).toContain("9.9 GB of 32 GB in containers");
        expect(container.textContent).toContain("8 cores");
    });

    it("draws a segment for every group that is using something, and none for one that is not", () => {
        const { container } = render(<ConsumptionSplit consumption={CONSUMPTION} />);
        const bar = container.querySelector('[role="presentation"]');
        // Polaris, apps and everything else - not the empty services group, which
        // would be a sliver of colour standing for nothing.
        expect(bar?.children).toHaveLength(3);
        expect([...(bar?.children ?? [])].map((segment) => segment.getAttribute("title"))).toContain(
            "Marketplace apps: 8 GB"
        );
    });

    it("gives every group a figure in the legend, including the empty one", () => {
        render(<ConsumptionSplit consumption={CONSUMPTION} />);
        for (const label of ["Polaris itself", "Marketplace apps", "Deployed services", "Everything else"]) {
            expect(screen.getAllByTitle(label).length).toBeGreaterThan(0);
        }
        expect(screen.getByText("22% CPU")).toBeTruthy();
    });

    it("says how many of a group's containers are up when they are not all up", () => {
        render(<ConsumptionSplit consumption={CONSUMPTION} />);
        expect(screen.getByText("2 of 3 running")).toBeTruthy();
        // Everything up is a count, not a fraction: "6 of 6" is a number to read
        // twice for nothing.
        expect(screen.getByText("6 containers")).toBeTruthy();
    });

    it("says the figures are still being taken rather than showing an age it does not have", () => {
        render(<ConsumptionSplit consumption={{ ...CONSUMPTION, sampledAt: null }} />);
        expect(screen.getByText(/measuring/)).toBeTruthy();
    });
});

describe("a group's table", () => {
    it("lists a row per thing, with whose it is and what it is using", () => {
        render(
            <ConsumptionGroupTable
                group={group({
                    id: "apps",
                    rows: [row({ id: "1", name: "Survival", memUsedBytes: 4 * GB })],
                    containers: 1,
                    memUsedBytes: 4 * GB,
                    cpuPercent: 12
                })}
            />
        );
        expect(screen.getByText("Survival")).toBeTruthy();
        expect(screen.getByText("Ada")).toBeTruthy();
        expect(screen.getAllByText("4 GB").length).toBeGreaterThan(0);
        expect(screen.getByText("3.5%")).toBeTruthy();
    });

    it("opens the thing when the reader may open it, and says nothing when they may not", () => {
        const { container } = render(
            <ConsumptionGroupTable
                group={group({
                    id: "apps",
                    rows: [
                        row({ id: "1", name: "Survival", href: "/apps/installed/1" }),
                        row({ id: "2", name: "Hidden", href: null })
                    ]
                })}
            />
        );
        expect(container.querySelector('a[href="/apps/installed/1"]')?.textContent).toBe("Survival");
        expect(screen.getByText("Hidden").closest("a")).toBeNull();
    });

    it("says where an install is when it is not on this machine, instead of leaving it looking idle", () => {
        render(
            <ConsumptionGroupTable
                group={group({
                    id: "apps",
                    rows: [
                        row({
                            id: "1",
                            name: "Bed wars",
                            state: "elsewhere",
                            stateLabel: "Not on this machine",
                            containers: 0,
                            cpuPercent: null,
                            memUsedBytes: null
                        })
                    ]
                })}
            />
        );
        expect(screen.getByText("Not on this machine")).toBeTruthy();
        // Two dashes, not two zeroes: nothing was measured, and a zero would say
        // the app is running and idle.
        expect(screen.getAllByText("-")).toHaveLength(2);
    });

    it("counts the containers behind a row that is more than one", () => {
        render(
            <ConsumptionGroupTable
                group={group({ id: "services", rows: [row({ id: "2", name: "api", detail: "Web / prod", containers: 3 })] })}
            />
        );
        expect(screen.getByText(/Web \/ prod - 3 containers/)).toBeTruthy();
    });

    it("says a group is empty rather than drawing an empty table", () => {
        render(<ConsumptionGroupTable group={group({ id: "services", rows: [] })} />);
        expect(screen.getByText("Nothing deployed here yet.")).toBeTruthy();
    });
});
