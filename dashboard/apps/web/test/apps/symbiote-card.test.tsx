// @vitest-environment jsdom

/**
 * Symbiote on the Mods tab.
 *
 * Pinned: on NeoForge 1.21.4 a manager installs it in one click and players get
 * the same jar from the download button; elsewhere nothing is offered and the
 * reason is said; a viewer sees the download but not the install; and removing
 * it asks first, since its blocks leave the world with it.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as actions from "@polaris-app/game-servers/src/screens/installed/symbiote-actions";
import { SymbioteCard } from "@polaris-app/game-servers/src/screens/installed/symbiote-card";
import type { SymbioteState } from "@polaris-app/game-servers/src/lib/minecraft/symbiote-service";

vi.mock("@polaris-app/game-servers/src/screens/installed/symbiote-actions", () => ({
    symbioteStateAction: vi.fn(),
    setSymbioteAction: vi.fn(async () => ({}))
}));

const SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b298";
const READY: SymbioteState = { installed: false, fit: "fits", reachable: true, bundled: true };

function show(state: SymbioteState, canManage = true) {
    vi.mocked(actions.symbioteStateAction).mockResolvedValue({ state });
    render(<SymbioteCard installedAppId={SERVER} canManage={canManage} />, {
        wrapper: MessagesWrapper
    });
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

    it("hands players the jar the server downloads", async () => {
        show(READY, false);
        const link = await screen.findByRole("link", { name: /download for your game/i });
        expect(link.getAttribute("href")).toBe("/api/minecraft/mod/symbiote-neoforge-1.21.4.jar");
        // A viewer can download it but not install it.
        expect(
            (screen.getByRole("button", { name: /install on server/i }) as HTMLButtonElement)
                .disabled
        ).toBe(true);
        expect(screen.getByText(/only somebody who manages this server/i)).toBeTruthy();
    });

    it("offers nothing on another release or software, and says why", async () => {
        show({ ...READY, fit: "release" });
        expect(await screen.findByText(/set the server's version to 1\.21\.4/i)).toBeTruthy();
        expect(
            (screen.getByRole("button", { name: /install on server/i }) as HTMLButtonElement)
                .disabled
        ).toBe(true);
        expect(screen.queryByRole("link", { name: /download for your game/i })).toBeNull();
        cleanup();
        show({ ...READY, fit: "loader" });
        expect(await screen.findByText(/runs on neoforge 1\.21\.4 only/i)).toBeTruthy();
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
