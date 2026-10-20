// Getting into a call through `api/chat/calls/[op]`, end to end: the browser
// half sends the step, the route reads it back, and the action it replaces is
// called with what the screen asked for. The screen tests replace the browser
// half (test/setup/app-polls.ts), so a step the two halves disagree on is
// caught here.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/app/(app)/chat/call-requests");

const session = vi.hoisted(() => ({ backgroundUser: vi.fn() }));
const actions = vi.hoisted(() => {
    const names = [
        "startCallAction",
        "joinCallAction",
        "joinMeetingAction",
        "callTokenAction",
        "readCallAction",
        "ownVoiceAction",
        "licensedFilterAction",
        "claimCallAction"
    ] as const;
    return Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<
        (typeof names)[number],
        ReturnType<typeof vi.fn>
    >;
});

vi.mock("@/lib/session", () => session);
vi.mock("@/app/(app)/chat/meeting-actions", () => actions);

const requests = await import("@/app/(app)/chat/call-requests");
const { POST } = await import("@/app/api/chat/calls/[op]/route");

const MEETING = "6f1c2a52-8a40-4c55-9b07-5d1f2b7e9a10";
let origin = "http://polaris.test";

function call(op: string, body: unknown, from = origin) {
    return POST(
        new Request(`http://polaris.test/api/chat/calls/${op}`, {
            method: "POST",
            headers: { host: "polaris.test", origin: from, "content-type": "application/json" },
            body: JSON.stringify(body)
        }),
        { params: Promise.resolve({ op }) }
    );
}

beforeEach(() => {
    origin = "http://polaris.test";
    session.backgroundUser.mockReset().mockResolvedValue({ id: "u1" });
    for (const spy of Object.values(actions)) spy.mockReset();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            const op = url.replace("/api/chat/calls/", "");
            return call(op, JSON.parse(String(init.body)));
        })
    );
});

const CASES = [
    { name: "start", ask: () => requests.startCall("c1"), action: "startCallAction", args: ["c1"] },
    {
        name: "join",
        ask: () => requests.joinCall(MEETING),
        action: "joinCallAction",
        args: [MEETING]
    },
    {
        name: "join-meeting",
        ask: () => requests.joinMeeting(MEETING),
        action: "joinMeetingAction",
        args: [MEETING]
    },
    {
        name: "ticket",
        ask: () => requests.callTicket(MEETING),
        action: "callTokenAction",
        args: [MEETING]
    },
    {
        name: "read",
        ask: () => requests.readCall(MEETING),
        action: "readCallAction",
        args: [MEETING]
    },
    {
        name: "own-voice",
        ask: () => requests.ownVoice(MEETING),
        action: "ownVoiceAction",
        args: [MEETING]
    },
    {
        name: "licensed-filter",
        ask: () => requests.licensedFilter(MEETING),
        action: "licensedFilterAction",
        args: [MEETING]
    },
    {
        name: "claim",
        ask: () => requests.claimCall(MEETING, "device-1"),
        action: "claimCallAction",
        args: [MEETING, "device-1"]
    }
] as const;

describe("each step of getting into a call, through its route", () => {
    it.each(CASES)("$name reaches its action with what the screen asked", async (entry) => {
        const answer = { meetingId: MEETING, at: new Date("2026-10-20T10:00:00Z") };
        actions[entry.action].mockResolvedValue(answer);
        await expect(entry.ask()).resolves.toEqual(answer);
        expect(actions[entry.action]).toHaveBeenCalledWith(...entry.args);
    });

    it("rejects when the step fails, so the screen says so instead of waiting", async () => {
        actions.startCallAction.mockRejectedValue(new Error("boom"));
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(requests.startCall("c1")).rejects.toThrow();
    });

    it("gives up on a step that never answers", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) =>
                        init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
                    )
            )
        );
        vi.useFakeTimers();
        try {
            const pending = requests.startCall("c1");
            const settled = expect(pending).rejects.toBeTruthy();
            await vi.advanceTimersByTimeAsync(21_000);
            await settled;
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("what the route refuses", () => {
    it("a request from another site", async () => {
        const response = await call("start", { channelId: "c1" }, "https://elsewhere.test");
        expect(response.status).toBe(403);
        expect(actions.startCallAction).not.toHaveBeenCalled();
    });

    it("a step it does not have, including the object's own keys", async () => {
        expect((await call("nope", {})).status).toBe(404);
        expect((await call("constructor", {})).status).toBe(404);
    });

    it("a body that is not the step's", async () => {
        expect((await call("join", { meetingId: "not-a-uuid" })).status).toBe(400);
        expect(actions.joinCallAction).not.toHaveBeenCalled();
    });

    it("starting a call with no session, while a guest's seat still gets its ticket", async () => {
        session.backgroundUser.mockResolvedValue(null);
        expect((await call("start", { channelId: "c1" })).status).toBe(401);
        actions.callTokenAction.mockResolvedValue({ waiting: true });
        expect((await call("ticket", { meetingId: MEETING })).status).toBe(200);
    });
});
