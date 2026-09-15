// @vitest-environment jsdom

/**
 * What the browser says when it has nothing to show.
 *
 * An empty result is the one screen here that has to explain itself, and the
 * explanation is only true under conditions the screen has to check first. A
 * plugin server never filtered a client-only project out of anything, a search
 * that failed is not a statement about what Modrinth has, and a browse that never
 * came back has to resolve to something a reader can act on rather than to
 * skeletons that stay up.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { InstalledAppSetting } from "@/lib/apps/install-service";
import { MinecraftMods } from "@/app/(app)/apps/installed/[id]/minecraft-mods";

vi.mock("@/app/(app)/apps/installed/[id]/minecraft-actions", () => ({
    updateServerSettingsAction: vi.fn()
}));

const CLIENT_ONLY = /client-only one/;

function settingsFor(type: string): InstalledAppSetting[] {
    return [
        { key: "MODRINTH_PROJECTS", label: "Mods and plugins", value: "" },
        { key: "MODRINTH_DOWNLOAD_DEPENDENCIES", label: "Dependencies", value: "required" },
        { key: "TYPE", label: "Server software", value: type },
        { key: "VERSION", label: "Version", value: "1.21.4" }
    ];
}

/** Every browse answers the same way, so a test only says what that way is. */
function stubSearch(answer: () => Partial<Response> & { json: () => Promise<unknown> }): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
            const url = input.toString();
            if (url.includes("installed="))
                return {
                    ok: true,
                    json: async () => ({ projects: [], conflicts: [], requires: [] })
                } as unknown as Response;
            return answer() as unknown as Response;
        })
    );
}

const empty = () => ({ ok: true, json: async () => ({ projects: [] }) });

/** The browse is debounced, so every wait here outlasts that rather than the
 *  default second, which is close enough to it to fail on a busy machine. */
const SETTLED = { timeout: 5000 };

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("what an empty browse says", () => {
    it("explains client-only mods on a modded server", async () => {
        stubSearch(empty);
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settingsFor("FABRIC")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        expect(await screen.findByText(CLIENT_ONLY, {}, SETTLED)).toBeTruthy();
    });

    it("says nothing about client-only mods on a plugin server", async () => {
        stubSearch(empty);
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settingsFor("PAPER")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        // The empty state is up - the copy that would be false on it is not.
        expect(
            await screen.findByText(/Nothing on Modrinth runs on paper/, {}, SETTLED)
        ).toBeTruthy();
        expect(screen.queryByText(CLIENT_ONLY)).toBeNull();
    });

    it("does not claim a match failed when nothing was searched for", async () => {
        stubSearch(empty);
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settingsFor("FABRIC")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        expect(
            await screen.findByText(
                /Nothing on Modrinth runs on fabric with a build for 1\.21\.4/,
                {},
                SETTLED
            )
        ).toBeTruthy();
        expect(screen.queryByText(/matches "/)).toBeNull();
    });

    it("offers a retry instead of an explanation when the search is refused", async () => {
        stubSearch(() => ({
            ok: false,
            json: async () => ({ error: "Search for a mod or plugin by name" })
        }));
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settingsFor("FABRIC")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        expect(await screen.findByRole("button", { name: "Try again" }, SETTLED)).toBeTruthy();
        expect(screen.queryByText(CLIENT_ONLY)).toBeNull();
    });

    it("resolves to a retry rather than skeletons when Modrinth cannot be reached", async () => {
        stubSearch(() => {
            throw new Error("offline");
        });
        render(
            <MinecraftMods
                installedAppId="server-1"
                settings={settingsFor("FABRIC")}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        expect(await screen.findByRole("button", { name: "Try again" }, SETTLED)).toBeTruthy();
        expect(screen.getByText("Could not reach Modrinth")).toBeTruthy();
    });
});
