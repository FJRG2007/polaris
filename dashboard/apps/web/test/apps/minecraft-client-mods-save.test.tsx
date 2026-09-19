// @vitest-environment jsdom

/**
 * The players' list keeps a change the moment it is made.
 *
 * It used to wait for a Save button in the corner of the card, away from the
 * search where Add is pressed. An Add that nobody saved looked done on screen and
 * was gone after the next reload - which is how a mod "added" to the players'
 * list never reached a single player. Nothing here restarts anything, so there
 * is nothing to confirm: Add saves, Remove saves, and a save that fails puts the
 * list back the way the server has it and says so.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { updateClientModsAction } from "@polaris-app/game-servers/src/screens/installed/minecraft-actions";
import { MinecraftClientMods } from "@polaris-app/game-servers/src/screens/installed/minecraft-client-mods";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({
    updateClientModsAction: vi.fn()
}));

const save = vi.mocked(updateClientModsAction);

const FOUND = {
    slug: "sodium-dynamic-lights",
    title: "Sodium Dynamic Lights",
    description: "Dynamic lights",
    downloads: 1,
    categories: [],
    iconUrl: null,
    author: null,
    clientOnly: true,
    serverOnly: false
};

beforeEach(() => {
    save.mockReset();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
            const url = input.toString();
            const body = url.includes("query=") ? { projects: [FOUND] } : { projects: [], pack: [] };
            return { ok: true, json: async () => body } as unknown as Response;
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function panel() {
    return render(
        <MinecraftClientMods
            installedAppId="server-1"
            loader="neoforge"
            version="1.21.4"
            entries={["xaeros-minimap"]}
            serverEntries={[]}
            packCommands={null}
        />
    );
}

describe("the players' list", () => {
    it("saves on Add, with no Save button to find", async () => {
        save.mockResolvedValue({});
        const user = userEvent.setup();
        panel();

        await user.click(await screen.findByRole("button", { name: /^Add$/ }));

        await waitFor(() =>
            expect(save).toHaveBeenCalledWith("server-1", [
                "xaeros-minimap",
                "sodium-dynamic-lights"
            ])
        );
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
        expect(screen.getByRole("button", { name: /Added/ })).toBeTruthy();
    });

    it("puts the list back and says why when the save fails", async () => {
        save.mockResolvedValue({ error: "You cannot manage this server" });
        const user = userEvent.setup();
        panel();

        await user.click(await screen.findByRole("button", { name: /^Add$/ }));

        expect(await screen.findByText("You cannot manage this server")).toBeTruthy();
        expect(await screen.findByRole("button", { name: /^Add$/ })).toBeTruthy();
    });
});
