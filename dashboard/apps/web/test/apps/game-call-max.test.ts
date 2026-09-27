/**
 * `{call.max}`: how many people the chat group has, beside `{call.count}` the
 * way `{server.max}` sits beside `{server.online}`.
 *
 * Asked for because "In call: {call.count}/{call.max}" was refused on the side
 * panel as not something Polaris could fill in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const GROUP = "01a09cdd-7a10-7811-833d-8b014c82de02";

const fake = vi.hoisted(() => ({
    config: "{}",
    members: 0,
    inCall: [] as string[],
    counted: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findUnique: async () => ({ name: "Survival", config: fake.config }) },
        chatChannelMember: {
            count: async (query: unknown) => {
                fake.counted.push(query);
                return fake.members;
            }
        },
        // Never read for who is in the call: that is the chat's answer (below).
        meetingParticipant: {
            findMany: async () => {
                throw new Error("open seats are not who is in the call");
            }
        }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: { readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}") },
        chatCalls: {
            // The chat's own rule: only the seats whose browser is still there.
            voicePresence: async (channels: string[]) =>
                new Map(
                    channels.map((id) => [
                        id,
                        fake.inCall.map((name, at) => ({ id: `p${at}`, name }))
                    ])
                )
        }
    }
}));

const { liveContext } = await import("@polaris-app/game-servers/src/lib/minecraft/live-values");
const { fillValues, variableProblem } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/text-vars"
);
const { sidebarProblems, DEFAULT_SIDEBAR, plainLine } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/sidebar"
);

beforeEach(() => {
    fake.config = JSON.stringify({ callGroupId: GROUP });
    fake.members = 5;
    fake.inCall = ["Ada", "Grace"];
    fake.counted = [];
});

describe("{call.max}", () => {
    it("is something Polaris can fill in, on either edition and on the side panel", () => {
        const line = "In Call: {call.count}/{call.max}";
        expect(variableProblem(line, "java")).toBeNull();
        expect(variableProblem(line, "bedrock")).toBeNull();
        expect(
            sidebarProblems({ ...DEFAULT_SIDEBAR, enabled: true, lines: [plainLine(line)] }).lines
        ).toEqual([[null]]);
    });

    it("reads how many people the chosen group has", async () => {
        const context = await liveContext("install", ["In Call: {call.count}/{call.max}"], null);
        expect(context.values["call.max"]).toBe("5");
        expect(context.values["call.count"]).toBe("2");
        expect(fake.counted).toEqual([{ where: { channelId: GROUP } }]);
        expect(fillValues("In Call: {call.count}/{call.max}", context.values)).toBe("In Call: 2/5");
    });

    it("counts who the chat shows in the call, not every seat left open", async () => {
        fake.inCall = ["Ada"];
        const context = await liveContext("install", ["{call.count} {call.members}"], null);
        expect(context.values["call.count"]).toBe("1");
        expect(context.values["call.members"]).toBe("Ada");
    });

    it("is not asked for when no text uses it", async () => {
        await liveContext("install", ["In Call: {call.count}"], null);
        expect(fake.counted).toEqual([]);
    });

    it("reads as its fallback when no group is chosen", async () => {
        fake.config = "{}";
        const context = await liveContext("install", ['{call.max | "?"}'], null);
        expect(context.values["call.max"]).toBeNull();
        expect(fillValues('{call.max | "?"}', context.values)).toBe("?");
    });
});
