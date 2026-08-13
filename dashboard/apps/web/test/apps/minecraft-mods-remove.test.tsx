// @vitest-environment jsdom

/**
 * Taking a mod off the list asks first.
 *
 * The row disappears on one click with nothing to put it back - so what has to be
 * proven is the interaction itself, not just the function it eventually calls:
 * the confirmation dialog actually opens before anything is dropped, Cancel
 * leaves the list untouched, and only confirming takes the row off screen.
 */

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MinecraftMods } from "@/app/(app)/apps/installed/[id]/minecraft-mods";

vi.mock("@/app/(app)/apps/installed/[id]/minecraft-actions", () => ({
    updateServerSettingsAction: vi.fn()
}));

const SETTINGS: InstalledAppSetting[] = [
    { key: "MODRINTH_PROJECTS", label: "Mods and plugins", value: "coreprotect?" },
    { key: "MODRINTH_DOWNLOAD_DEPENDENCIES", label: "Dependencies", value: "required" },
    { key: "TYPE", label: "Server software", value: "PAPER" },
    { key: "VERSION", label: "Version", value: "1.21.4" }
];

const INSTALLED_PROJECT = {
    slug: "coreprotect",
    title: "CoreProtect",
    description: "Block logging and rollback",
    downloads: 0,
    categories: [],
    iconUrl: null,
    author: null,
    entry: "coreprotect?",
    known: true,
    fitsVersion: true,
    fitsLoader: true
};

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
            const url = input.toString();
            if (url.includes("installed=")) {
                return {
                    ok: true,
                    json: async () => ({ projects: [INSTALLED_PROJECT], conflicts: [] })
                } as unknown as Response;
            }
            return { ok: true, json: async () => ({ projects: [] }) } as unknown as Response;
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("removing a mod from an installed server", () => {
    it("holds the row until the dialog is confirmed, and drops it on Cancel", async () => {
        const user = userEvent.setup();
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={SETTINGS}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        await screen.findByText("CoreProtect");

        await user.click(screen.getByRole("button", { name: "Remove CoreProtect" }));

        expect(await screen.findByText("Remove CoreProtect?")).toBeTruthy();
        expect(
            screen.getByText(
                "It comes off the list now. The server uninstalls it when you save and restart."
            )
        ).toBeTruthy();

        // Cancel: the dialog closes and the row is exactly where it was.
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByText("Remove CoreProtect?")).toBeNull();
        expect(screen.getByText("CoreProtect")).toBeTruthy();

        // Confirm: the dialog closes and the row is gone.
        await user.click(screen.getByRole("button", { name: "Remove CoreProtect" }));
        await screen.findByText("Remove CoreProtect?");
        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(screen.queryByText("Remove CoreProtect?")).toBeNull();
        expect(screen.queryByText("CoreProtect")).toBeNull();
        expect(
            await screen.findByText("Nothing installed yet. Browse below to add a mod or plugin.")
        ).toBeTruthy();
    });
});
