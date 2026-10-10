// @vitest-environment jsdom

/**
 * Symbiote as a row of the Mods tab's list.
 *
 * Pinned: it shows Polaris's mark and is credited to Polaris; on NeoForge 1.21.4
 * a manager installs it in one click; players are pointed at the pack's line and
 * never handed a download link, since the jar is not public; on another release
 * the reason is said, and on another loader the row is not there at all; a
 * viewer cannot install it; the list hears whether it is installed; and
 * removing it asks first, since its blocks leave the world with it.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as actions from "@polaris-app/game-servers/src/screens/installed/symbiote-actions";
import { SymbioteRow } from "@polaris-app/game-servers/src/screens/installed/symbiote-card";
import type { SymbioteState } from "@polaris-app/game-servers/src/lib/minecraft/symbiote-service";

vi.mock("@polaris-app/game-servers/src/screens/installed/symbiote-actions", () => ({
    symbioteStateAction: vi.fn(),
    setSymbioteAction: vi.fn(async () => ({}))
}));

const SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b298";
const READY: SymbioteState = { installed: false, fit: "fits", reachable: true, bundled: true };

function show(state: SymbioteState, canManage = true) {
    vi.mocked(actions.symbioteStateAction).mockResolvedValue({ state });
    return render(
        <ul>
            <SymbioteRow installedAppId={SERVER} canManage={canManage} />
        </ul>,
        { wrapper: MessagesWrapper }
    );
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("Symbiote on the Mods tab", () => {
    it("installs on NeoForge 1.21.4 in one click, and says when it takes effect", async () => {
        const user = userEvent.setup();
        show(READY);
        await user.click(await screen.findByRole("button", { name: /install on server/i }));
        expect(actions.setSymbioteAction).toHaveBeenCalledWith({
            installedAppId: SERVER,
            on: true
        });
        expect(await screen.findByText(/downloads it on its next start/i)).toBeTruthy();
        expect(screen.getByText("Installed")).toBeTruthy();
    });

    it("is credited to Polaris, and points players at the pack's line instead of a download", async () => {
        show(READY, false);
        expect(await screen.findByText("by Polaris")).toBeTruthy();
        expect(screen.getByText(/send this to the players/i)).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull();
        // A viewer cannot install it.
        expect(
            (screen.getByRole("button", { name: /install on server/i }) as HTMLButtonElement)
                .disabled
        ).toBe(true);
        expect(screen.getByText(/only somebody who manages this server/i)).toBeTruthy();
    });

    it("says why on another release, and is not listed on other software", async () => {
        show({ ...READY, fit: "release" });
        expect(await screen.findByText(/set the server's version to 1\.21\.4/i)).toBeTruthy();
        expect(
            (screen.getByRole("button", { name: /install on server/i }) as HTMLButtonElement)
                .disabled
        ).toBe(true);
        cleanup();
        const { container } = show({ ...READY, fit: "loader" });
        await vi.waitFor(() => expect(actions.symbioteStateAction).toHaveBeenCalled());
        await vi.waitFor(() => expect(container.querySelector("li")).toBeNull());
    });

    it("asks before removing it, and leaves it on Cancel", async () => {
        const user = userEvent.setup();
        show({ ...READY, installed: true });
        await user.click(await screen.findByRole("button", { name: /^remove$/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog.textContent).toMatch(/blocks and items/i);
        await user.click(screen.getByRole("button", { name: /cancel/i }));
        expect(actions.setSymbioteAction).not.toHaveBeenCalled();
        expect(screen.getByText("Installed")).toBeTruthy();
    });

    it("tells the list whether it is installed, so the list is not called empty", async () => {
        const onInstalled = vi.fn();
        vi.mocked(actions.symbioteStateAction).mockResolvedValue({
            state: { ...READY, installed: true }
        });
        render(
            <ul>
                <SymbioteRow installedAppId={SERVER} canManage onInstalled={onInstalled} />
            </ul>,
            { wrapper: MessagesWrapper }
        );
        await vi.waitFor(() => expect(onInstalled).toHaveBeenLastCalledWith(true));
    });

    it("puts it back when the change fails", async () => {
        const user = userEvent.setup();
        vi.mocked(actions.setSymbioteAction).mockResolvedValueOnce({
            error: "Could not change Symbiote"
        });
        show(READY);
        await user.click(await screen.findByRole("button", { name: /install on server/i }));
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.queryByText("Installed")).toBeNull();
    });
});
