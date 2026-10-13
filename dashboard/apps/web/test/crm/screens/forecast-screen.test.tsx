// @vitest-environment jsdom

/**
 * The forecast screen: the figures in the reader's currency, a period per
 * row with past-due deals apart, odds that can be changed only with the
 * right to change opportunities, and a bad percent caught before it is sent.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { buildForecast, DEFAULT_ODDS, forecastRange } from "@polaris-app/crm/src/model/forecast";

const state = vi.hoisted(() => ({
    canEdit: true,
    calls: [] as unknown[],
    saved: [] as unknown[]
}));

vi.mock("@polaris-app/crm/src/actions/forecast", () => ({
    forecastAction: async (input: unknown) => {
        state.calls.push(input);
        const range = forecastRange(new Date("2026-10-13T00:00:00Z"), "month", 6);
        const day = (text: string) => new Date(`${text}T00:00:00Z`);
        return {
            ok: true,
            canEditOdds: state.canEdit,
            forecast: buildForecast(
                [
                    {
                        closeDate: day("2026-10-20"),
                        stage: "proposal",
                        currency: "EUR",
                        deals: 1,
                        amount: 1000
                    },
                    {
                        closeDate: day("2026-10-21"),
                        stage: "customer",
                        currency: "EUR",
                        deals: 1,
                        amount: 500
                    },
                    {
                        closeDate: day("2026-09-01"),
                        stage: "meeting",
                        currency: "EUR",
                        deals: 2,
                        amount: 300
                    }
                ],
                DEFAULT_ODDS,
                range,
                "month"
            )
        };
    },
    saveOddsAction: async (input: unknown) => {
        state.saved.push(input);
        return { ok: true, odds: input };
    }
}));

import { ForecastScreen } from "@polaris-app/crm/src/screens/forecast-screen";

beforeEach(() => {
    state.canEdit = true;
    state.calls = [];
    state.saved = [];
    if (typeof sessionStorage !== "undefined") sessionStorage.clear();
    if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(cleanup);

describe("forecast", () => {
    it("shows expected, won and open, by period, with past-due deals apart", async () => {
        render(<ForecastScreen />, { wrapper: MessagesWrapper });
        const table = await screen.findByRole("table", { name: "Forecast by period" });
        const rows = within(table).getAllByRole("row");
        // Header, six months, total, past due.
        expect(rows).toHaveLength(9);
        expect(within(rows[1]!).getByText("(1 won)")).toBeTruthy();
        expect(rows[8]!.textContent).toContain("Past due");
        expect(state.calls[0]).toEqual({ granularity: "month", periods: 6, mine: false });
        // Expected: 500 won + 1000 at 60%.
        expect(screen.getAllByText(/1,100/).length).toBeGreaterThan(0);
    });

    it("asks again for the reader's own deals", async () => {
        render(<ForecastScreen />, { wrapper: MessagesWrapper });
        await screen.findByRole("table", { name: "Forecast by period" });
        await act(async () => {
            fireEvent.click(screen.getByRole("radio", { name: "Mine" }));
        });
        expect(state.calls).toContainEqual({ granularity: "month", periods: 6, mine: true });
    });

    it("keeps changed odds and refuses a percent over 100", async () => {
        render(<ForecastScreen />, { wrapper: MessagesWrapper });
        await screen.findByRole("table", { name: "Forecast by period" });
        fireEvent.click(screen.getByRole("button", { name: "Stage odds" }));
        const dialog = await screen.findByRole("dialog");
        const inputs = within(dialog).getAllByRole("textbox");
        fireEvent.change(inputs[3]!, { target: { value: "120" } });
        expect(within(dialog).getByText("Each one is a whole number from 0 to 100.")).toBeTruthy();
        expect(
            (within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled
        ).toBe(true);
        fireEvent.change(inputs[3]!, { target: { value: "80" } });
        await act(async () => {
            fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
        });
        expect(state.saved).toEqual([{ ...DEFAULT_ODDS, proposal: 80 }]);
    });

    it("shows the odds without letting a reader change them", async () => {
        state.canEdit = false;
        render(<ForecastScreen />, { wrapper: MessagesWrapper });
        await screen.findByRole("table", { name: "Forecast by period" });
        fireEvent.click(screen.getByRole("button", { name: "Stage odds" }));
        const dialog = await screen.findByRole("dialog");
        expect(
            within(dialog)
                .getAllByRole("textbox")
                .every((input) => (input as HTMLInputElement).disabled)
        ).toBe(true);
        expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    });
});
