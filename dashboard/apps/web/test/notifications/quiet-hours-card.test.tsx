// @vitest-environment jsdom

/**
 * The quiet hours card: Save stays off until something actually changed, the
 * zone the hours are read in is named, and a refused save puts the old value
 * back with the reason.
 */

import { MessagesWrapper } from "../setup/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuietHours } from "@polaris/core";

const save = vi.fn(async (_input: QuietHours): Promise<{ error?: string }> => ({}));

vi.mock("@/app/(app)/account/notifications/actions", () => ({
    saveQuietHoursAction: (input: QuietHours) => save(input)
}));

const { QuietHoursCard } = await import("@/app/(app)/account/notifications/quiet-hours-card");

const OFF: QuietHours = { enabled: false, start: "22:00", end: "08:00", criticalBypass: true };

afterEach(() => {
    cleanup();
    save.mockReset();
    save.mockImplementation(async () => ({}));
});

describe("quiet hours", () => {
    it("names the zone and holds Save until something changed", () => {
        render(<QuietHoursCard initial={OFF} timeZone="Europe/Madrid" />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText(/Europe\/Madrid/)).toBeTruthy();
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
            true
        );
    });

    it("saves the window once switched on", async () => {
        render(<QuietHoursCard initial={OFF} timeZone="UTC" />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(save).toHaveBeenCalledWith({ ...OFF, enabled: true }));
    });

    it("shows the reason when the save is refused", async () => {
        save.mockImplementation(async () => ({ error: "Not saved." }));
        render(<QuietHoursCard initial={OFF} timeZone="UTC" />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Not saved.")).toBeTruthy();
    });
});
