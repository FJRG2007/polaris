/**
 * The side panel's `{call.count}` follows the call as it happens.
 *
 * Reported as "somebody left the call and the number did not change". Two
 * causes: the count read every seat still open, and a seat stays open after a
 * closed tab until the chat notices the browser went quiet; and the panel only
 * looked again every ten seconds. Now the count is the chat's own, and a join or
 * a leave redraws the panel on the next tick rather than at the end of the
 * period.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GROUP = "01a09cdd-7a10-7811-833d-8b014c82de02";

const fake = vi.hoisted(() => ({
    inCall: [] as string[],
    said: [] as string[],
    listener: null as ((event: { meetingId: string; kind: string }) => void) | null
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({
                name: "Survival",
                catalogId: "minecraft",
                status: "running",
                config: JSON.stringify({
                    mcRelease: "1.21.1",
                    callGroupId: GROUP,
                    sidebar: { enabled: true, title: "Polaris", lines: ["In call: {call.count}"] }
                })
            })
        },
        chatChannelMember: { count: async () => 5 }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}"),
            patchInstallConfig: async () => undefined
        },
        chatCalls: {
            voicePresence: async (channels: string[]) =>
                new Map(channels.map((id) => [id, fake.inCall.map((name, at) => ({ id: `p${at}`, name }))])),
            subscribeMeetingEvents: async (listener: (event: { meetingId: string; kind: string }) => void) => {
                fake.listener = listener;
                return () => undefined;
            }
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: () => "java",
    onlinePlayers: async () => null,
    withServerContainer: async (_owner: string, _id: string, work: (server: unknown) => unknown) =>
        work({
            running: true,
            say: async (argv: string[]) => {
                fake.said.push(argv[0] ?? "");
            }
        })
}));

const live = await import("@polaris-app/game-servers/src/lib/minecraft/live-display-service");

/** What the panel's first line was last set to. */
const shownCount = () =>
    fake.said
        .filter((line) => line.includes("display name polaris.line.01"))
        .map((line) => /In call: (\d+)/.exec(line)?.[1])
        .at(-1);

beforeEach(() => {
    vi.useFakeTimers();
    fake.inCall = ["Ada", "Grace"];
    fake.said = [];
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the call on the side panel", () => {
    it("drops somebody who left on the next tick, not at the end of the period", async () => {
        live.startLiveDisplay("owner", "install");
        await vi.advanceTimersByTimeAsync(2_100);
        expect(shownCount()).toBe("2");

        fake.inCall = ["Ada"];
        fake.listener?.({ meetingId: "m1", kind: "roster" });
        // One action-bar tick, far inside the panel's ten-second period.
        await vi.advanceTimersByTimeAsync(2_100);
        expect(shownCount()).toBe("1");
    });

    it("pays no attention to what is not somebody arriving or leaving", async () => {
        live.startLiveDisplay("owner", "install");
        await vi.advanceTimersByTimeAsync(2_100);
        fake.inCall = ["Ada"];
        fake.said = [];
        fake.listener?.({ meetingId: "m1", kind: "said" });
        await vi.advanceTimersByTimeAsync(2_100);
        expect(shownCount()).toBeUndefined();
    });
});
