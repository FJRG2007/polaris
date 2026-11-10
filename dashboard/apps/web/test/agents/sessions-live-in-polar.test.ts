/**
 * Agent sessions live in Polar's Code side. The Agents app keeps the repository
 * work - reviews, pull requests, issues - and no longer has a Sessions screen.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_SECTIONS } from "@/lib/apps";

describe("agent sessions", () => {
    it("have no screen of their own in the Agents app", () => {
        const agents = join(process.cwd(), "src/app/(app)/apps/agents/sessions");
        expect(existsSync(agents)).toBe(false);
        const hrefs = (APP_SECTIONS.agents ?? []).map((section) => section.href);
        expect(hrefs.some((href) => href.startsWith("/apps/agents/sessions"))).toBe(false);
    });

});
