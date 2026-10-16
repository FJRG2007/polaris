// @vitest-environment jsdom
/**
 * The setup opened by itself on the Overview: leaving it before anything was
 * installed is a skip, installs under way keep it open, and leaving it once
 * any has run is finishing it.
 */

import { withMessages } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

let release: () => void = () => undefined;
const finishSetupAction = vi.fn(async (_outcome: string) => ({}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/(app)/setup-actions", () => ({
    setupStateAction: async () => ({ offer: true, installed: [] }),
    setupInstalledAction: async () => [],
    finishSetupAction: (outcome: string) => finishSetupAction(outcome),
    installSetupAppAction: () =>
        new Promise<{ error?: string }>((resolve) => {
            release = () => resolve({});
        })
}));

const { SetupWizardOffer } = await import("@/components/setup/setup-wizard-entry");

beforeEach(() => finishSetupAction.mockClear());
afterEach(cleanup);

async function open() {
    render(withMessages(<SetupWizardOffer />));
    return screen.findByRole("dialog");
}

describe("the setup offered on the Overview", () => {
    it("records a skip when it is closed before anything was installed", async () => {
        const user = userEvent.setup();
        await open();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(finishSetupAction).toHaveBeenCalledWith("skipped");
    });

    it("stays open while installs run, and is finished once they have", async () => {
        const user = userEvent.setup();
        await open();
        await user.click(screen.getByRole("checkbox", { name: /Running game servers/ }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Install 1 app" }));
        await user.keyboard("{Escape}");
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
        expect(finishSetupAction).not.toHaveBeenCalled();
        release();
        await waitFor(() =>
            expect(
                (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled
            ).toBe(false)
        );
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(finishSetupAction).toHaveBeenCalledWith("done");
    });
});
