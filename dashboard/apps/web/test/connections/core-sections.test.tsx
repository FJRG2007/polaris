/**
 * The hub's sections for Polaris's own apps: issue trackers only for whoever
 * every tracker action would let through, AI keys for everybody, and the old
 * trackers screen sending people to the hub and back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let canManageTasks = false;
const listTrackers = vi.fn(async () => []);
const redirect = vi.fn((href: string) => {
    throw new Error(`redirect:${href}`);
});

vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => key
}));
vi.mock("@/lib/session", () => ({
    sessionCan: async (_user: unknown, permission: string) =>
        permission === "tasks.manage" && canManageTasks,
    requirePermission: async () => ({ id: "user-1" })
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/tasks/trackers/service", () => ({ listTrackers }));
vi.mock("@/app/(app)/account/ai-keys/ai-keys-panel", () => ({ AiKeysPanel: () => null }));
vi.mock("@/app/(app)/tasks/trackers/trackers-view", () => ({ TrackersView: () => null }));

const { hubCoreSections } = await import("../../src/app/(app)/account/connections/core-sections");
const user = { id: "user-1" } as Parameters<typeof hubCoreSections>[0];

describe("hubCoreSections", () => {
    beforeEach(() => {
        canManageTasks = false;
        listTrackers.mockClear();
    });

    it("offers AI keys to everybody and never reads trackers for whoever cannot manage tasks", async () => {
        const sections = await hubCoreSections(user);
        expect(sections.ids).toEqual(["ai-keys"]);
        expect(listTrackers).not.toHaveBeenCalled();
    });

    it("lists the reader's own trackers for whoever manages tasks", async () => {
        canManageTasks = true;
        const sections = await hubCoreSections(user);
        expect(sections.ids).toEqual(["task-trackers", "ai-keys"]);
        expect(listTrackers).toHaveBeenCalledWith("user-1");
    });
});

describe("/tasks/trackers", () => {
    it("sends people to the hub's trackers section, with the way back to Tasks", async () => {
        const { default: page } = await import("../../src/app/(app)/tasks/trackers/page");
        await expect(page()).rejects.toThrow(
            "redirect:/account/connections?provider=task-trackers&return=%2Ftasks"
        );
    });
});
