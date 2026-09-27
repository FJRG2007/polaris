// @vitest-environment jsdom

/**
 * "Add a leaderboard" on the side panel: a heading and the list under it, for
 * somebody who does not know `{rank.deaths}` by name.
 *
 * What is pinned: every block is something the panel accepts as it is; a block
 * that does not fit is not added; and choosing one in the menu puts its two
 * lines at the end of the panel.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    SIDEBAR_BLOCKS,
    withBlock
} from "@polaris-app/game-servers/src/lib/minecraft/sidebar-blocks";
import {
    DEFAULT_SIDEBAR,
    SIDEBAR_LINES_MAX,
    sidebarProblems
} from "@polaris-app/game-servers/src/lib/minecraft/sidebar";

Element.prototype.scrollIntoView ??= () => undefined;

vi.mock("@polaris-app/game-servers/src/screens/installed/live-display-actions", () => ({
    readLiveDisplayAction: async () => ({
        state: {
            sidebar: { ...DEFAULT_SIDEBAR, enabled: true },
            callGroupId: null,
            groups: [],
            sidebarRefusal: null
        }
    }),
    saveLiveDisplayAction: async () => ({})
}));
vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        confirmDialog: { useConfirm: () => [async () => true, null] },
        copyButton: { CopyButton: () => null }
    }
}));

const { MinecraftSidebar } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-sidebar"
);

afterEach(cleanup);

describe("the ready-made blocks", () => {
    it("are each something the panel takes as it is", () => {
        for (const block of SIDEBAR_BLOCKS) {
            const problems = sidebarProblems({
                ...DEFAULT_SIDEBAR,
                enabled: true,
                lines: [...block.lines]
            });
            expect([block.id, problems.lines]).toEqual([block.id, block.lines.map(() => null)]);
        }
    });

    it("are not added where they do not fit", () => {
        const full = Array.from({ length: SIDEBAR_LINES_MAX - 1 }, () => "");
        expect(withBlock(full, SIDEBAR_BLOCKS[0]!, SIDEBAR_LINES_MAX)).toBeNull();
        expect(withBlock(["a"], SIDEBAR_BLOCKS[1]!, SIDEBAR_LINES_MAX)).toEqual([
            "a",
            ...SIDEBAR_BLOCKS[1]!.lines
        ]);
    });
});

describe("Add a leaderboard", () => {
    it("puts a heading and the list at the end of the panel", async () => {
        const { container } = render(<MinecraftSidebar installedAppId="s1" canManage />);
        await screen.findByRole("button", { name: /Add a leaderboard/ });
        const lines = () => [...container.querySelectorAll("textarea")].slice(1);
        const before = lines().length;
        fireEvent.pointerDown(screen.getByRole("button", { name: /Add a leaderboard/ }), {
            button: 0,
            ctrlKey: false
        });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Most deaths" }));
        expect(lines()).toHaveLength(before + 2);
        expect(lines().at(-2)?.value).toBe("Most deaths");
        expect(lines().at(-1)?.value).toContain("rank.deaths");
    });
});
