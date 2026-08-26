/**
 * Two questions, both of which have to be answered before a screen draws a
 * control: which spaces this account reaches, and whether it may change work at
 * all.
 *
 * The context used to answer only the first. Somebody holding `tasks.read` and a
 * place on a space's roster came back as a member who could edit everything,
 * which is what every task screen reads to decide what to draw.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tasks/space-service", () => ({
    listStatuses: async () => [],
    listTags: async () => [],
    listCustomFields: async () => [],
    spacePeople: async () => []
}));
vi.mock("@/lib/tasks/task-service", () => ({ listTasks: async () => [] }));

const { buildSpaceContext } = await import("@/lib/tasks/screen-context");

describe("what a space context says somebody may do", () => {
    it("refuses editing to a member who may not manage work", async () => {
        const context = await buildSpaceContext("s1", "member", "u1", false);
        expect(context.canEdit).toBe(false);
        expect(context.canModerate).toBe(false);
    });

    it("refuses moderating to an owner who may not manage work", async () => {
        const context = await buildSpaceContext("s1", "owner", "u1", false);
        expect(context.canEdit).toBe(false);
        expect(context.canModerate).toBe(false);
    });

    it("still separates the roles for somebody who may", async () => {
        const member = await buildSpaceContext("s1", "member", "u1", true);
        expect(member.canEdit).toBe(true);
        expect(member.canModerate).toBe(false);

        const owner = await buildSpaceContext("s1", "owner", "u1", true);
        expect(owner.canEdit).toBe(true);
        expect(owner.canModerate).toBe(true);
    });

    it("gives a guest nothing either way", async () => {
        const guest = await buildSpaceContext("s1", "guest", "u1", true);
        expect(guest.canEdit).toBe(false);
        expect(guest.canModerate).toBe(false);
    });
});
