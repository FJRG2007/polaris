// @vitest-environment jsdom

/**
 * What a member of a conversation linked to a game server sees: the server's
 * mark beside the conversation, a chip in the header that opens the server's
 * page only for somebody who may open it, and its commands first when "/" is
 * typed - picking one writes it, ready to send.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { menuItems as blocksFor, type SlashCommand } from "@/components/rich-text/block-menu";
import { translatorFor } from "@/lib/i18n/translate";

/** The list as an English reader is shown it. */
const english = translatorFor("en-US", "components");
const menuItems = (commands: readonly SlashCommand[], query: string) =>
    blocksFor(commands, query, (id) => english(`editor.blocks.${id}`));
import { GameLinkChips, GameLinkMark } from "@/app/(app)/chat/game-link-badge";

afterEach(cleanup);

const COMMANDS = [
    { name: "online", description: "Who is playing right now" },
    { name: "status", description: "Whether the server is up, and how full it is" }
];

const LINK = {
    installedAppId: "survival",
    name: "Survival",
    game: "Minecraft",
    logo: "/logos/minecraft.webp",
    href: "/apps/installed/survival",
    commands: COMMANDS
};

describe("the / list", () => {
    it("offers the conversation's commands first, then the blocks", () => {
        const items = menuItems(COMMANDS, "");
        expect(items.slice(0, 2).map((item) => item.label)).toEqual(["/online", "/status"]);
        expect(items.slice(2).map((item) => item.label)).toContain("Heading");
        // Anywhere else, only the blocks.
        expect(menuItems([], "")[0]?.label).toBe("Text");
    });

    it("narrows the commands by what is typed after the slash", () => {
        const commands = (query: string) =>
            menuItems(COMMANDS, query)
                .map((item) => item.label)
                .filter((label) => label.startsWith("/"));
        expect(commands("st")).toEqual(["/status"]);
        expect(commands("online")).toEqual(["/online"]);
        // And the blocks that match still follow them.
        expect(menuItems(COMMANDS, "st").map((item) => item.label)).toContain("Checklist");
    });

    it("writes the command with a space after it, so the list does not open on it again", () => {
        const done: string[] = [];
        const chain = {
            focus: () => chain,
            deleteRange: () => chain,
            insertContent: (text: string) => {
                done.push(text);
                return chain;
            },
            run: () => true
        };
        const editor = { chain: () => chain } as never;
        menuItems(COMMANDS, "on")[0]?.run(editor, { from: 1, to: 4 });
        expect(done).toEqual(["/online "]);
    });
});

describe("the mark", () => {
    it("says which server, in the rail", () => {
        render(<GameLinkMark links={[LINK]} />, { wrapper: MessagesWrapper });
        expect(
            screen.getByRole("img", { name: "Linked to the Minecraft server Survival" })
        ).toBeTruthy();
    });

    it("opens the server's page from the header for somebody who may open it", () => {
        render(<GameLinkChips links={[LINK]} />, { wrapper: MessagesWrapper });
        const chip = screen.getByRole("link", { name: /Minecraft server Survival/ });
        expect(chip.getAttribute("href")).toBe("/apps/installed/survival");
    });

    it("is only words for everybody else", () => {
        render(<GameLinkChips links={[{ ...LINK, href: null }]} />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("link")).toBeNull();
        expect(screen.getByText("Survival")).toBeTruthy();
    });

    it("draws nothing for a conversation linked to nothing", () => {
        const { container } = render(
            <>
                <GameLinkMark links={[]} />
                <GameLinkChips links={[]} />
            </>, { wrapper: MessagesWrapper }
        );
        expect(container.innerHTML).toBe("");
    });
});
