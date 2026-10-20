/**
 * Polar's page carries its own list of chats, projects and recents, as Chat and
 * Mail do, so the app rail draws nothing beside it: one sidebar, not two.
 */

import { describe, expect, it } from "vitest";
import { APP_SECTIONS } from "@/lib/apps";

describe("the app rail on Polar's page", () => {
    it("draws no entry beside Polar's own list, and the page stays findable", () => {
        const sections = APP_SECTIONS.polar ?? [];
        expect(sections.some((section) => section.href === "/polar")).toBe(true);
        expect(sections.every((section) => section.hidden)).toBe(true);
    });
});
