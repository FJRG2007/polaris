// @vitest-environment jsdom

/**
 * The compare screen on the way in: the picker, the range and the table's
 * headings are on screen before the history answers, only the waiting cells and
 * charts are skeletons, a fifth server cannot be added, and a reader with one
 * server is told how to get a second instead of facing an empty chart.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { MetricPoint } from "@/lib/metrics-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CompareView, latestOf } from "../../src/app/(app)/apps/servers/compare/compare-view";
import { ServerInsightsPanel } from "../../src/app/(app)/apps/servers/insights/server-insights-panel";

const SERVERS = [
    { id: "local", name: "polaris-box" },
    { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51", name: "web-1" },
    { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52", name: "web-2" },
    { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a53", name: "db-1" },
    { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a54", name: "a-server-with-a-very-long-name-that-has-to-truncate" }
];

const fetched: string[] = [];

beforeEach(() => {
    fetched.length = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
            fetched.push(url);
            return new Promise(() => {});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("CompareView", () => {
    it("paints the picker, range and table headings before the history answers", () => {
        const { container } = render(
            <CompareView servers={SERVERS} initialIds={["local", SERVERS[1]!.id]} initialRange="1d" />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("Servers to compare")).toBeTruthy();
        expect(screen.getByText("2 of 4 chosen")).toBeTruthy();
        expect(screen.getByRole("radiogroup", { name: "Time range" })).toBeTruthy();
        expect(screen.getByRole("columnheader", { name: "CPU" })).toBeTruthy();
        expect(screen.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["polaris-box", "web-1"]);
        // Only the waiting regions are skeletons: four charts and eight cells.
        expect(container.querySelectorAll(".animate-pulse").length).toBe(12);
        expect(fetched[0]).toContain("/api/servers/compare?ids=local%2C");
        expect(fetched[0]).toContain("range=1d");
    });

    it("asks for a second server rather than reading one alone", () => {
        render(<CompareView servers={SERVERS} initialIds={["local"]} initialRange="1d" />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Choose at least two servers to compare them.")).toBeTruthy();
        expect(fetched).toHaveLength(0);
    });

    it("stops at four servers and says why", () => {
        render(
            <CompareView servers={SERVERS} initialIds={SERVERS.slice(0, 4).map((one) => one.id)} initialRange="7d" />,
            { wrapper: MessagesWrapper }
        );
        const fifth = screen.getByRole("button", { name: /a-server-with-a-very-long-name/ });
        expect(fifth.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(fifth);
        expect(fifth.getAttribute("aria-pressed")).toBe("false");
        expect(screen.getAllByText("Up to 4 servers at once. Remove one to add another.").length).toBeGreaterThan(0);
    });

    it("tells a reader with one server how to get another", () => {
        render(<CompareView servers={SERVERS.slice(0, 1)} initialIds={["local"]} initialRange="1d" />, {
            wrapper: MessagesWrapper
        });
        expect(
            screen.getByText("There is only one server so far. Add another under Servers to compare them.")
        ).toBeTruthy();
    });
});

describe("latestOf", () => {
    const point = (t: number, cpuPercent: number | null): MetricPoint => ({
        t,
        cpuPercent,
        cpuTempC: null,
        memUsedBytes: 2,
        memTotalBytes: 8,
        diskUsedBytes: null,
        diskTotalBytes: null,
        netRxBytesPerSecond: 100,
        netTxBytesPerSecond: null
    });

    it("reads the newest reading that exists, and says null when there is none", () => {
        const points = [point(1, 40), point(2, null)];
        expect(latestOf(points, "cpu")).toBe(40);
        expect(latestOf(points, "memory")).toBe(25);
        expect(latestOf(points, "disk")).toBeNull();
        expect(latestOf(points, "network")).toBe(100);
    });
});

describe("ServerInsightsPanel", () => {
    it("says plainly when there is not enough history, and warns about a disk that fills soon", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    servers: [
                        {
                            id: "local",
                            subject: "local",
                            anomalies: [],
                            forecast: { kind: "insufficient", spanDays: 0.5, usedBytes: null, totalBytes: null },
                            diskWarning: false,
                            historyHours: 12
                        },
                        {
                            id: SERVERS[1]!.id,
                            subject: SERVERS[1]!.id,
                            anomalies: [
                                {
                                    start: Date.UTC(2026, 9, 9, 3),
                                    end: Date.UTC(2026, 9, 9, 5),
                                    direction: "high",
                                    peakAt: Date.UTC(2026, 9, 9, 4),
                                    peakValue: 96,
                                    baseline: 21,
                                    score: 9.25,
                                    metric: "cpu",
                                    severity: "danger"
                                }
                            ],
                            forecast: {
                                kind: "filling",
                                usedBytes: 90e9,
                                totalBytes: 100e9,
                                bytesPerDay: 2e9,
                                spanDays: 9,
                                days: 5
                            },
                            diskWarning: true,
                            historyHours: 216
                        }
                    ]
                })
            )
        );
        render(<ServerInsightsPanel servers={SERVERS.slice(0, 2)} />, { wrapper: MessagesWrapper });
        // The headings are there before the answer.
        expect(screen.getByText("Disk forecast")).toBeTruthy();
        expect(await screen.findByText("Not enough history yet. A forecast needs 2 days of readings.")).toBeTruthy();
        expect(screen.getByText("Full in about 5 days")).toBeTruthy();
        expect(screen.getByText("Fills soon")).toBeTruthy();
        expect(screen.getByText("Severe")).toBeTruthy();
        expect(screen.getByText(/96%, usually 21%/)).toBeTruthy();
        expect(screen.queryByText(/usual spread/)).toBeNull();
    });

    it("tells a server too new to judge from one that was calm", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    servers: [
                        {
                            id: "local",
                            subject: "local",
                            anomalies: [],
                            forecast: { kind: "insufficient", spanDays: 0.2, usedBytes: null, totalBytes: null },
                            diskWarning: false,
                            historyHours: 5
                        }
                    ]
                })
            )
        );
        render(<ServerInsightsPanel servers={SERVERS.slice(0, 1)} />, { wrapper: MessagesWrapper });
        expect(
            await screen.findByText("Not enough history yet. Unusual activity is spotted after 13 hours of readings.")
        ).toBeTruthy();
        expect(screen.queryByText("Nothing unusual in the last 7 days.")).toBeNull();
    });
});
