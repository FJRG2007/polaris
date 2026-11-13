// @vitest-environment jsdom

/**
 * The Performance table: rows from the server, sorted by the server, and a slow
 * route marked against its target.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const row = {
    id: "route-1",
    name: "/checkout/:step",
    op: "pageload",
    metric: "lcp",
    count: 1234,
    p50: 1800,
    p75: 3100,
    p95: 5200,
    baselineP75: 2000,
    target: 2500,
    ownTarget: false,
    issueId: null,
    lastSeen: "2026-01-01T00:00:00.000Z"
};

const telemetryPerformance = vi.fn(async (_input: Record<string, unknown>) => ({
    data: { items: [row], next: null, projectTarget: null, ops: ["pageload"] }
}));

vi.mock("@/app/(app)/telemetry/telemetry-polls", () => ({
    telemetryPerformance,
    telemetryRoute: vi.fn()
}));
vi.mock("@/app/(app)/telemetry/actions", () => ({}));

const { PerformanceList, trendOf } = await import("@/app/(app)/telemetry/performance");

afterEach(cleanup);

describe("the Performance table", () => {
    it("draws each route with its percentiles, target and trend", async () => {
        render(<PerformanceList projectId="p1" readOnly hrefFor={(id) => `/r/${id}`} />, {
            wrapper: MessagesWrapper
        });
        const link = await screen.findByText("/checkout/:step");
        expect(link.closest("a")?.getAttribute("href")).toBe("/r/route-1");
        expect(screen.getByText("3.10 s")).toBeTruthy();
        expect(screen.getByText("2.50 s")).toBeTruthy();
        expect(screen.getByText("+55%")).toBeTruthy();
        expect(telemetryPerformance.mock.calls[0]?.[0]).toMatchObject({ projectId: "p1", sort: "p75", cursor: null });
    });

    it("asks the server for another order when a column is pressed", async () => {
        render(<PerformanceList projectId="p1" readOnly hrefFor={(id) => `/r/${id}`} />, {
            wrapper: MessagesWrapper
        });
        await screen.findByText("/checkout/:step");
        fireEvent.click(screen.getByRole("button", { name: /p95/ }));
        await waitFor(() =>
            expect(telemetryPerformance.mock.calls.at(-1)?.[0]).toMatchObject({ sort: "p95" })
        );
    });

    it("has no trend without history", () => {
        expect(trendOf({ p75: 100, baselineP75: null })).toBeNull();
        expect(trendOf({ p75: 150, baselineP75: 100 })).toBe(50);
    });
});
