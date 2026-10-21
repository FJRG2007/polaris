/**
 * Saving or publishing a notify step that delivers through a Deploy project's
 * webhook or a messaging channel: each one must be one the saver may use - the
 * project's settings for a webhook, owning the channel for a messaging target.
 * A save only asks about what it adds, as with chat webhooks.
 */

import type * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OUR_HOOK = "00000000-0000-4000-8000-0000000000b1";
const THEIR_HOOK = "00000000-0000-4000-8000-0000000000b2";
const OUR_CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const THEIR_CHANNEL = "00000000-0000-4000-8000-0000000000c2";

const state = vi.hoisted(() => ({ asked: [] as string[] }));

vi.mock("@polaris/auth", () => ({ userHasPermission: async () => true }));
vi.mock("@/lib/deploy-project-access", () => ({
    projectAccess: async (projectId: string) =>
        projectId === "ours" ? { capabilities: ["project.settings"] } : null,
    accessCan: () => true
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        projectWebhook: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                state.asked.push(where.id);
                return { projectId: where.id === OUR_HOOK ? "ours" : "theirs" };
            }
        },
        channel: {
            findFirst: async ({ where }: { where: { id: string } }) => {
                state.asked.push(where.id);
                return where.id === OUR_CHANNEL ? { id: where.id } : null;
            }
        }
    }
}));

const { checkNoticeTargets } = await import("@/lib/automations/notice-targets");
const { AutomationAccessError } = await import("@/lib/automations/access-error");

const ME = { id: "user-fixture", isAdmin: false };

function graph(hooks: string[], channel: string | null): core.AutomationGraph {
    return {
        schema: 1,
        timeZone: "UTC",
        nodes: [
            { id: "start", type: "core.manual", typeVersion: 1, config: {} },
            {
                id: "tell",
                type: "core.notify",
                typeVersion: 1,
                config: {
                    title: "Alarm",
                    body: "",
                    delivery: {
                        bell: true,
                        projectWebhooks: hooks,
                        messaging: channel ? { channelId: channel, peerId: "42" } : null
                    }
                }
            }
        ],
        edges: []
    } as unknown as core.AutomationGraph;
}

beforeEach(() => {
    state.asked = [];
});

describe("a notify step's Watch targets on save", () => {
    it("accepts a project webhook and a channel the saver runs", async () => {
        await expect(checkNoticeTargets(ME, graph([OUR_HOOK], OUR_CHANNEL))).resolves.toBe(
            undefined
        );
    });

    it("refuses a project webhook on somebody else's project", async () => {
        await expect(checkNoticeTargets(ME, graph([THEIR_HOOK], null))).rejects.toBeInstanceOf(
            AutomationAccessError
        );
    });

    it("refuses a messaging channel somebody else owns", async () => {
        await expect(checkNoticeTargets(ME, graph([], THEIR_CHANNEL))).rejects.toBeInstanceOf(
            AutomationAccessError
        );
    });

    it("lets somebody else keep what the graph already named", async () => {
        const before = graph([THEIR_HOOK], THEIR_CHANNEL);
        await expect(checkNoticeTargets(ME, before, before)).resolves.toBe(undefined);
        expect(state.asked).toEqual([]);
    });
});
