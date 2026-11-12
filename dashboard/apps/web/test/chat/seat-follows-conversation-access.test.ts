/**
 * A seat in a conversation's call is only good while its holder can still read
 * the conversation (VULN-0040). The seat is what a media ticket and a heartbeat
 * are proved by, so one kept after the access went would go on minting tickets
 * for the call: it is closed instead, and the media server told to drop it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let access: object | null = {};
let channelId: string | null = "c1";
const closed: string[] = [];
const applyToSeat = vi.fn(async () => true);

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: () => undefined }));
vi.mock("@/lib/chat/call-server", () => ({ applyToSeat }));
vi.mock("@/lib/chat/access", async (actual) => ({
    ...(await actual<typeof import("@/lib/chat/access")>()),
    channelAccess: vi.fn(async () => access)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async () => ({ id: "m1", channelId, endedAt: null, title: "" }),
            findFirst: async () => null,
            findMany: async () => [],
            updateMany: async () => ({ count: 0 })
        },
        meetingParticipant: {
            findFirst: async () => ({ id: "p1", admission: "admitted", meeting: { channelId } }),
            updateMany: async ({ where }: { where: { id?: string } }) => {
                if (where.id) closed.push(where.id);
                return { count: 1 };
            },
            findMany: async () => [],
            count: async () => 1
        },
        $transaction: async () => undefined
    }
}));

const { seatForUser } = await import("@/lib/chat/meetings");

beforeEach(() => {
    access = {};
    channelId = "c1";
    closed.length = 0;
    applyToSeat.mockClear();
});

describe("a seat in a conversation's call", () => {
    it("is answered while its holder can still read the conversation", async () => {
        expect(await seatForUser("ada", "m1")).toMatchObject({ participantId: "p1" });
        expect(closed).toEqual([]);
    });

    it("is closed and dropped from the media server once they cannot", async () => {
        access = null;
        expect(await seatForUser("ada", "m1")).toBeNull();
        expect(closed).toContain("p1");
        expect(applyToSeat).toHaveBeenCalledWith("m1", "p1", { kind: "remove" });
    });

    it("is not asked about a conversation when the meeting has none", async () => {
        channelId = null;
        access = null;
        expect(await seatForUser("ada", "m1")).toMatchObject({ participantId: "p1" });
    });
});
