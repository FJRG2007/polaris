/**
 * Which mailboxes Mail draws: the shelf in the header, or every one of them.
 *
 * The listing filter is what is pinned here, because everything else in Mail -
 * the rail, the counts, the arrival notices - is drawn from it, and a filter
 * that quietly answers "every mailbox" is a company's mail on somebody's own
 * screen.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { onShelf } = await import("@/lib/mailbox/access");
const { EVERY_SHELF, isEveryShelf } = await import("@/lib/mailbox/shelf");

describe("the listing filter", () => {
    it("names the shelf on somebody's own shelf, which is no organization", () => {
        expect(onShelf("u1", null)).toEqual({ userId: "u1", orgId: null });
    });

    it("names the organization on one of its shelves", () => {
        expect(onShelf("u1", "org-acme")).toEqual({ userId: "u1", orgId: "org-acme" });
    });

    it("asks for no shelf at all when every mailbox was asked for", () => {
        expect(onShelf("u1", EVERY_SHELF)).toEqual({ userId: "u1" });
    });

    it("cannot be confused with an organization, since no id is that value", () => {
        expect(isEveryShelf(EVERY_SHELF)).toBe(true);
        expect(isEveryShelf(null)).toBe(false);
        expect(isEveryShelf("org-acme")).toBe(false);
    });
});
