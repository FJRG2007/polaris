// @vitest-environment jsdom
/**
 * The schedule picker shared by scheduled jobs and scheduled sessions, drawn
 * where it started: a service's scheduled jobs. Presets, the typed expression
 * and the time zone read and write the job's draft the way they did before the
 * picker moved. Fixture data throughout.
 */

import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/apps/deploy/cron-actions", () => ({
    listServiceCronsAction: async () => ({ crons: [] }),
    runServiceCronAction: async () => ({}),
    saveServiceCronAction: async () => ({}),
    deleteServiceCronAction: async () => ({})
}));
vi.mock("@/app/(app)/apps/deploy/deploy-polls", () => ({ serviceCronRuns: async () => null }));
vi.mock("@/app/(app)/apps/deploy/access-context", () => ({ useProjectCan: () => () => true }));
vi.mock("@/components/restore-history", () => ({ RestoreHistoryButton: () => null }));
vi.mock("@/components/json-view", () => ({ CodeEditor: () => null }));

const { CronPanel } = await import("@/app/(app)/apps/deploy/cron-panel");

afterEach(cleanup);

describe("scheduled jobs' schedule picker", () => {
    it("starts a new job daily at 03:00 in the browser's zone, read back in words", async () => {
        render(withMessages(<CronPanel applicationId="app-fixture" />));
        fireEvent.click(await screen.findByRole("button", { name: "New job" }));
        const expression = screen.getByLabelText("Cron expression") as HTMLInputElement;
        expect(expression.value).toBe("0 3 * * *");
        expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe(
            Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        );
        for (const label of ["Every 15 minutes", "Hourly", "Daily at 03:00", "Mondays at 09:00", "Monthly"]) {
            expect(screen.getByRole("button", { name: label })).toBeTruthy();
        }
        expect(screen.getByText(/ - next /)).toBeTruthy();
    });

    it("writes a preset and a typed expression into the job", async () => {
        render(withMessages(<CronPanel applicationId="app-fixture" />));
        fireEvent.click(await screen.findByRole("button", { name: "New job" }));
        fireEvent.click(screen.getByRole("button", { name: "Hourly" }));
        const expression = screen.getByLabelText("Cron expression") as HTMLInputElement;
        expect(expression.value).toBe("0 * * * *");
        fireEvent.change(expression, { target: { value: "*/5 * * * *" } });
        expect(expression.value).toBe("*/5 * * * *");
        fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "UTC" } });
        expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("UTC");
    });
});
