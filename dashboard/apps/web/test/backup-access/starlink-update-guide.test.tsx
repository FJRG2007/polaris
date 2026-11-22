// @vitest-environment jsdom

/**
 * On a Starlink line the line card says how to keep its update restarts out of
 * the day, naming the hour this deployment is least used; on any other line it
 * says nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string, values?: { time?: string }) =>
        values?.time ? `${key} @ ${values.time}` : key
}));
vi.mock("@/components/display-format", () => ({
    useDisplayFormat: () => ({ time: (value: string) => `time(${value})` })
}));

import { StarlinkUpdateGuide } from "@/app/(app)/admin/domains/starlink-update-guide";
import type { BackupView } from "@/lib/backup-access/service";

const QUIET_AT = "2026-11-22T03:00:00.000Z";
const view = (starlinkQuietAt: string | null) => ({ starlinkQuietAt }) as BackupView;

afterEach(cleanup);

describe("StarlinkUpdateGuide", () => {
    it("renders nothing on a line that is not Starlink", () => {
        const { container } = render(<StarlinkUpdateGuide view={view(null)} />);
        expect(container.innerHTML).toBe("");
    });

    it("opens to the steps, with the quiet hour in the reader's time", () => {
        render(<StarlinkUpdateGuide view={view(QUIET_AT)} />);
        expect(screen.queryByText(/steps\.window/)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "domains.backup.starlink.show" }));
        expect(screen.getAllByRole("listitem")).toHaveLength(4);
        expect(screen.getByText(`domains.backup.starlink.steps.window @ time(${QUIET_AT})`)).toBeTruthy();
    });
});
