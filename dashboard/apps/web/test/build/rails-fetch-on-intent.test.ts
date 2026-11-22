/**
 * The rails drawn on every screen - the app rail and the chat rail - fetch the
 * screens behind their rows on intent, never on sight. With the router's
 * default each row in view was a request the moment a page loaded, so a reload
 * was a burst of one per visible row. See `components/intent-link`.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RAILS = ["src/components/app-sidebar.tsx", "src/app/(app)/chat/chat-sidebar.tsx"];

describe("the rails on every screen", () => {
    it.each(RAILS)("%s links through IntentLink, not next/link", (path) => {
        const source = readFileSync(join(__dirname, "../..", path), "utf8");
        expect(source).not.toMatch(/from "next\/link"/);
        expect(source).toMatch(/from "@\/components\/intent-link"/);
    });
});
