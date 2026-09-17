/**
 * What the tab's title says is waiting. It is rewritten on every navigation and
 * on every change of the count, so it must replace its own prefix rather than
 * stack a second one, and must leave a page's own title alone otherwise.
 */

import { describe, expect, it } from "vitest";
import { titleWithBadge } from "@/lib/favicon-style";

describe("titleWithBadge", () => {
    it("puts the count in front, the way the icon draws it", () => {
        expect(titleWithBadge("Chat", { kind: "count", label: "3" })).toBe("(3) Chat");
        expect(titleWithBadge("Chat", { kind: "count", label: "9+" })).toBe("(9+) Chat");
        expect(titleWithBadge("Chat", { kind: "dot" })).toBe("\u2022 Chat");
    });

    it("replaces its own prefix instead of stacking", () => {
        expect(titleWithBadge("(3) Chat", { kind: "count", label: "4" })).toBe("(4) Chat");
        expect(titleWithBadge("\u2022 Chat", { kind: "count", label: "1" })).toBe("(1) Chat");
    });

    it("takes the prefix off when nothing is waiting", () => {
        expect(titleWithBadge("(9+) Deploy", null)).toBe("Deploy");
        expect(titleWithBadge("Deploy", null)).toBe("Deploy");
    });
});
