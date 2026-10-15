// @vitest-environment jsdom
/**
 * The setup screen as somebody uses it: ticking uses with the keyboard, each
 * app row a label around one checkbox, installs reported one line each with a
 * retry for the one that failed, and skipping always within reach.
 */

import { withMessages } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { SetupApp } from "@/lib/setup/setup-wizard";

vi.mock("@/app/(app)/setup-actions", () => ({ installSetupAppAction: async () => ({}) }));

const { SetupWizard } = await import("@/components/setup/setup-wizard");

afterEach(cleanup);

function draw({
    installed = [] as readonly SetupApp[] | null,
    install = vi.fn(async (_app: SetupApp) => ({}) as { error?: string }),
    onFinish = vi.fn(),
    locale = "en-US" as "en-US" | "es-ES"
} = {}) {
    render(withMessages(<SetupWizard installed={installed} install={install} onFinish={onFinish} />, locale));
    return { install, onFinish };
}

describe("the setup screen", () => {
    it("ticks a use with the keyboard and moves on only once one is picked", async () => {
        const user = userEvent.setup();
        draw();
        const next = screen.getByRole("button", { name: "Next" });
        expect((next as HTMLButtonElement).disabled).toBe(true);
        const games = screen.getByRole("checkbox", { name: /Running game servers/ });
        games.focus();
        await user.keyboard(" ");
        expect((games as HTMLInputElement).checked).toBe(true);
        expect((next as HTMLButtonElement).disabled).toBe(false);
    });

    it("draws each app as a label around exactly one checkbox, installed ones locked", async () => {
        const user = userEvent.setup();
        draw({ installed: ["status-pages"] });
        await user.click(screen.getByRole("checkbox", { name: /Hosting and deploys/ }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        const boxes = screen.getAllByRole("checkbox");
        expect(boxes).toHaveLength(3);
        for (const box of boxes) {
            const label = box.closest("label");
            expect(label).not.toBeNull();
            expect(within(label as HTMLElement).getAllByRole("checkbox")).toHaveLength(1);
            const described = box.getAttribute("aria-describedby");
            expect(described && document.getElementById(described)?.textContent).toBeTruthy();
        }
        expect((boxes[0] as HTMLButtonElement).disabled).toBe(true);
        expect((boxes[0] as HTMLInputElement).checked).toBe(true);
        expect((screen.getByRole("button", { name: "Install 2 apps" }) as HTMLButtonElement).disabled).toBe(false);
        await user.click(boxes[1] as HTMLElement);
        expect((screen.getByRole("button", { name: "Install 1 app" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("installs only what is ticked, one line each, and retries the one that failed", async () => {
        const user = userEvent.setup();
        let fail = true;
        const install = vi.fn(async (app: SetupApp) =>
            app === "crm" && fail ? { error: "CRM was not installed. Retry." } : {}
        );
        const { onFinish } = draw({ install });
        await user.click(screen.getByRole("checkbox", { name: /Team workspace/ }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Install 2 apps" }));
        await screen.findByText("CRM was not installed. Retry.");
        expect(install.mock.calls.map(([app]) => app)).toEqual(["calendar", "crm"]);
        fail = false;
        await user.click(screen.getByRole("button", { name: /Retry CRM/ }));
        await waitFor(() => expect(screen.queryByText("CRM was not installed. Retry.")).toBeNull());
        expect(install).toHaveBeenCalledTimes(3);
        await user.click(screen.getByRole("button", { name: "Done" }));
        expect(onFinish).toHaveBeenCalledWith("done");
    });

    it("says a dropped connection in plain words", async () => {
        const user = userEvent.setup();
        draw({ install: vi.fn(async () => Promise.reject(new Error("fetch failed"))) });
        await user.click(screen.getByRole("checkbox", { name: /Running game servers/ }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Install 1 app" }));
        await screen.findByText(/Polaris did not answer/);
        expect(screen.queryByText(/fetch failed/)).toBeNull();
    });

    it("can be skipped from the first step", async () => {
        const user = userEvent.setup();
        const { onFinish, install } = draw();
        await user.click(screen.getByRole("button", { name: "Skip for now" }));
        expect(onFinish).toHaveBeenCalledWith("skipped");
        expect(install).not.toHaveBeenCalled();
    });

    it("waits only the app list on the server", async () => {
        const user = userEvent.setup();
        draw({ installed: null });
        await user.click(screen.getByRole("checkbox", { name: /Running game servers/ }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByLabelText("Checking what is installed")).toBeTruthy();
        expect((screen.getByRole("button", { name: "Skip for now" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("speaks Spanish", () => {
        draw({ locale: "es-ES" });
        expect(screen.getByRole("button", { name: "Ahora no" })).toBeTruthy();
        expect(screen.getByRole("checkbox", { name: /Servidores de juego/ })).toBeTruthy();
    });
});
