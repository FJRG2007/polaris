// @vitest-environment jsdom

/**
 * The counter under a text counts a value that is already settled as it is.
 *
 * The report: a panel title of `Polaris | {server.name}` read 42/32 and was
 * refused, because the server's name was counted at the widest a name can be
 * instead of at the name the server has. What is pinned: a known value counts
 * at its own length, an empty one at its fallback, and anything not known still
 * at its widest; the panel, the announcement and the counter all use it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { visibleLength } = await import("@polaris-app/game-servers/src/lib/minecraft/text-vars");
const { sidebarProblems, DEFAULT_SIDEBAR, plainLine, SIDEBAR_TITLE_MAX } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/sidebar"
);
const { announcementProblems, BLANK_ANNOUNCEMENT, LINE_MAX } = await import("@polaris-app/game-servers/src/lib/minecraft/announcement");
const { FieldNote } = await import("@polaris-app/game-servers/src/screens/installed/minecraft-announce");

afterEach(cleanup);

const TITLE = "Polaris | {server.name}";
const KNOWN = { "server.name": "Offgrid" };

describe("counting a text", () => {
    it("counts the server's name as it is, once it is known", () => {
        expect(visibleLength(TITLE)).toBe(42);
        expect(visibleLength(TITLE, KNOWN)).toBe(17);
    });

    it("counts an empty known value at its fallback, and an unknown one at its widest", () => {
        expect(visibleLength('{server.name | "Server"}', { "server.name": "" })).toBe(6);
        expect(visibleLength("{server.players}", KNOWN)).toBe(24);
    });
});

describe("what is refused", () => {
    it("takes a panel title that fits with the server's own name", () => {
        const sidebar = { ...DEFAULT_SIDEBAR, title: plainLine(TITLE) };
        expect(sidebarProblems(sidebar).title[0]).toBe(`At most ${SIDEBAR_TITLE_MAX} characters`);
        expect(sidebarProblems(sidebar, KNOWN).title[0]).toBeNull();
    });

    it("takes an announcement line that fits with the server's own name", () => {
        // A hundred characters and the name: too long at the widest name, not with this one.
        const draft = { ...BLANK_ANNOUNCEMENT, title: `${"x".repeat(100)}{server.name}` };
        const plain = announcementProblems(draft, "java").title;
        const known = announcementProblems(draft, "java", Date.now(), KNOWN).title;
        expect(plain).toBe(`At most ${LINE_MAX} characters on screen`);
        expect(known).toBeUndefined();
    });
});

describe("the counter under a field", () => {
    it("shows the length with the server's name in it", () => {
        render(<FieldNote text={TITLE} max={32} known={KNOWN} />);
        expect(screen.getByText("17/32")).toBeTruthy();
    });
});
