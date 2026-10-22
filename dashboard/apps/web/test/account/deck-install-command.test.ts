/**
 * The one-line install for Polaris for Stream Deck.
 *
 * What is pinned here is what would be silently wrong: a line built for the
 * wrong shell, a repository baked in rather than passed in, and a line offered
 * for a system Elgato's app does not run on.
 */

import { describe, expect, it } from "vitest";
import { INSTALL_PLATFORMS } from "@/lib/install-platform";
import {
    DECK_LINE_PLATFORMS,
    deckInstallCommand,
    deckLinePlatform
} from "@/lib/deck-install-command";

const REPO = "example-org/example-repo";

describe("the line that installs the Stream Deck plugin", () => {
    it("gives PowerShell its own line and macOS the shell one", () => {
        const windows = deckInstallCommand("windows", REPO);
        expect(windows.shell).toBe("PowerShell");
        expect(windows.command).toMatch(/^irm \S+\/install\.ps1 \| iex$/);
        const mac = deckInstallCommand("macos", REPO);
        expect(mac.shell).toBe("Terminal");
        expect(mac.command).toMatch(/^curl -fsSL \S+\/install\.sh \| sh$/);
    });

    it("points at the repository it was given, where the scripts live", () => {
        for (const platform of DECK_LINE_PLATFORMS) {
            const { command } = deckInstallCommand(platform, REPO);
            expect(command).toContain(
                `https://raw.githubusercontent.com/${REPO}/main/dashboard/apps/streamdeck/scripts/`
            );
            expect(command).not.toContain("FJRG2007");
        }
    });

    it("is offered only where the Stream Deck app runs", () => {
        expect(DECK_LINE_PLATFORMS).toEqual(["windows", "macos"]);
        // Every system the reader can be on lands on one of them.
        for (const platform of INSTALL_PLATFORMS) {
            expect(DECK_LINE_PLATFORMS).toContain(deckLinePlatform(platform));
        }
        expect(deckLinePlatform("macos")).toBe("macos");
        expect(deckLinePlatform("windows")).toBe("windows");
    });
});
