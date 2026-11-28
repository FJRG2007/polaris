// @vitest-environment jsdom
/**
 * The floor plan renders every table with its chairs, and every state carries
 * its own icon and words besides its color (staff who cannot tell the colors
 * apart, or a screen in bright daylight, still read it). Light and dark only
 * differ by the design tokens, so both themes draw the same marks.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDisplayFormat, DISPLAY_DEFAULTS } from "@polaris/core";

vi.mock("@polaris/app-host/client", () => ({ hostUi: { displayFormat: { useDisplayFormat: () => createDisplayFormat(DISPLAY_DEFAULTS) } } }));
vi.mock("@polaris-app/hospitality/src/screens/i18n", () => ({
    useHospitalityT: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(",")}` : key)
}));
vi.mock("@polaris-app/hospitality/src/screens/menu-screen", () => ({ useMoney: () => (cents: number) => `EUR ${(cents / 100).toFixed(2)}` }));

const { FloorPlan } = await import("@polaris-app/hospitality/src/screens/floor-plan");

afterEach(cleanup);

const table = (id: string, x: number, seats: number, shape = "square") => ({ id, roomId: "r", name: id, x, y: 1, width: 2, height: 2, shape, seats });
const order = (tableId: string, patch: object) => ({
    id: `o-${tableId}`, tableId, label: "", status: "open", covers: 2, waiterName: "Ana", note: "", openedAt: new Date().toISOString(),
    discount: null, lines: [], totals: { total: 1250 }, paid: 0, paidLineIds: [], version: 0, updatedByName: "", ...patch
});

describe.each(["light", "dark"])("hospitality floor plan (%s)", (theme) => {
    it("draws chairs, guests, state words and opens a table", () => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        const onPick = vi.fn();
        const rooms = { id: "r", name: "Room", tables: [table("1", 1, 4), table("2", 5, 6, "round"), table("3", 9, 2)] };
        const byTable = new Map<string | null, never>([
            ["2", order("2", { lines: [{ status: "sent", sentAt: new Date().toISOString() }] }) as never],
            ["3", order("3", { status: "billed", paid: 500, lines: [{ status: "served", sentAt: null }] }) as never]
        ]);
        const { container } = render(<FloorPlan currency="EUR" room={rooms} byTable={byTable} basic={false} selected={null} onPick={onPick} />);
        expect(container.querySelectorAll("g[role=button] > circle")).toHaveLength(12);
        const marks = screen.getAllByRole("button").filter((b) => b.tagName.toLowerCase() === "g");
        expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual([
            expect.stringContaining("floor.state.free"),
            expect.stringContaining("floor.state.kitchen"),
            expect.stringContaining("floor.state.paying")
        ]);
        expect(marks[1]?.getAttribute("aria-label")).toContain("Ana");
        expect(marks[1]?.getAttribute("aria-label")).toContain("EUR 12.50");
        // Each mark has an icon besides its color.
        for (const m of marks) expect(m.querySelector("svg")).not.toBeNull();
        fireEvent.click(marks[2]!);
        expect(onPick).toHaveBeenCalledWith("3");
    });
});
