/**
 * Messages typed mid-turn wait and go one per finished turn, oldest first; a
 * message is sent once even when two deliveries race, and one that fails to
 * send goes back to the front instead of being lost.
 */

import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    prisma: {} as Record<string, unknown>,
    log: [] as string[],
    steerable: true,
    takes: true,
    refusal: false
}));
vi.mock("@polaris/db", () => ({
    get prisma() {
        return fake.prisma;
    }
}));
vi.mock("@/lib/agents/session-runtime", () => ({
    canSteerTurn: async () => fake.steerable,
    placeAttachments: async (_session: unknown, _userId: string, files: { path: string }[]) => {
        fake.log.push(`place ${files.map((file) => file.path).join(",")}`);
    },
    steerTurn: async (_id: string, text: string) => {
        fake.log.push(`steer ${text}`);
        return fake.takes;
    }
}));
vi.mock("@/lib/agents/session-service", () => ({
    addSessionMessage: async (_id: string, _role: string, text: string) => {
        fake.log.push(`keep ${text}`);
    }
}));
vi.mock("@/lib/agents/session-attachments", () => ({
    sessionAttachmentsFor: async (_userId: string, ids: readonly string[]) =>
        fake.refusal ? { refusal: "missing" } : { files: ids.map((id) => ({ path: `/files/${id}` })) },
    withAttachmentNote: (text: string, paths: string[]) => `${text} [${paths.join(",")}]`
}));

import {
    deliverNextQueued,
    deliveryBatch,
    promptRoute,
    queueNowRoute,
    reorderedAt,
    shouldQueuePrompt,
    steerPromptNow,
    steerQueuedPrompt,
    type QueuePorts
} from "@/lib/agents/session-prompt-queue";
import type * as sessions from "@/lib/agents/session-service";

type Row = {
    id: string;
    text: string;
    authorId: string;
    attachments: string[];
    createdAt: Date;
    feedbackKey?: string | null;
};

function memoryPorts(rows: Row[], sendFails = false) {
    const sent: string[] = [];
    const ports: QueuePorts = {
        head: async (_sessionId, limit) =>
            [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit),
        claim: async (id) => {
            const index = rows.findIndex((row) => row.id === id);
            if (index < 0) return false;
            rows.splice(index, 1);
            return true;
        },
        putBack: async (_sessionId, row) => {
            rows.push({ id: `back-${row.text}`, ...row });
        },
        send: async (_sessionId, _authorId, text) => {
            if (sendFails) throw new Error("machine gone");
            sent.push(text);
        }
    };
    return { ports, sent, rows };
}

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 15, 10, 0, seconds));

describe("shouldQueuePrompt", () => {
    it("queues while the agent is mid-turn", () => {
        expect(shouldQueuePrompt("working", 0)).toBe(true);
    });

    it("sends at once to an agent at its prompt with nothing waiting", () => {
        expect(shouldQueuePrompt("idle", 0)).toBe(false);
    });

    it("queues while the agent waits on an approval or a question, which is not its prompt", () => {
        expect(shouldQueuePrompt("waiting", 0)).toBe(true);
    });

    it("queues behind messages already waiting, so none jumps the line", () => {
        expect(shouldQueuePrompt("idle", 2)).toBe(true);
    });

    it("never queues on a session that has ended", () => {
        expect(shouldQueuePrompt("stopped", 3)).toBe(false);
    });
});

describe("deliverNextQueued", () => {
    it("sends the oldest message, one per call, in the order typed", async () => {
        const { ports, sent, rows } = memoryPorts([
            { id: "b", text: "second", authorId: "u1", attachments: [], createdAt: at(2) },
            { id: "a", text: "first", authorId: "u1", attachments: [], createdAt: at(1) }
        ]);
        expect(await deliverNextQueued("s1", ports)).toBe(true);
        expect(sent).toEqual(["first"]);
        expect(rows.map((row) => row.id)).toEqual(["b"]);
        expect(await deliverNextQueued("s1", ports)).toBe(true);
        expect(sent).toEqual(["first", "second"]);
        expect(await deliverNextQueued("s1", ports)).toBe(false);
    });

    it("sends nothing when another delivery claimed the message first", async () => {
        const { ports, sent } = memoryPorts([
            { id: "a", text: "first", authorId: "u1", attachments: [], createdAt: at(1) }
        ]);
        const lost: QueuePorts = { ...ports, claim: async () => false };
        expect(await deliverNextQueued("s1", lost)).toBe(false);
        expect(sent).toEqual([]);
    });

    it("puts a message that could not be sent back at the front", async () => {
        const { ports, rows } = memoryPorts(
            [
                { id: "a", text: "first", authorId: "u1", attachments: ["f1"], createdAt: at(1) },
                { id: "b", text: "second", authorId: "u1", attachments: [], createdAt: at(2) }
            ],
            true
        );
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await deliverNextQueued("s1", ports)).toBe(false);
        quiet.mockRestore();
        const [next] = await ports.head("s1", 1);
        expect(next?.text).toBe("first");
        expect(next?.attachments).toEqual(["f1"]);
        expect(rows).toHaveLength(2);
    });
});

describe("Polaris's own messages", () => {
    const own = (id: string, seconds: number, key: string): Row => ({
        id,
        text: id,
        authorId: "owner",
        attachments: [],
        createdAt: at(seconds),
        feedbackKey: key
    });
    const typed = (id: string, seconds: number): Row => ({
        id,
        text: id,
        authorId: "u1",
        attachments: [],
        createdAt: at(seconds)
    });

    it("go together when they wait next to each other", async () => {
        const { ports, sent, rows } = memoryPorts([own("ci", 1, "ci:7"), own("review", 2, "review:7"), typed("hi", 3)]);
        expect(await deliverNextQueued("s1", ports)).toBe(true);
        expect(sent).toEqual(["ci\n\n---\n\nreview"]);
        expect(rows.map((row) => row.id)).toEqual(["hi"]);
    });

    it("never merge with a typed message, before or after", async () => {
        const { ports, sent } = memoryPorts([typed("hi", 1), own("ci", 2, "ci:7"), typed("bye", 3), own("conflict", 4, "conflict:7")]);
        for (let turn = 0; turn < 4; turn++) await deliverNextQueued("s1", ports);
        expect(sent).toEqual(["hi", "ci", "bye", "conflict"]);
    });

    it("all go back, with their keys, when the send fails", async () => {
        const { ports, rows } = memoryPorts([own("ci", 1, "ci:7"), own("review", 2, "review:7")], true);
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await deliverNextQueued("s1", ports)).toBe(false);
        quiet.mockRestore();
        expect(rows.map((row) => row.feedbackKey).sort()).toEqual(["ci:7", "review:7"]);
    });

    it("deliveryBatch takes a typed message alone and stops a run at the first typed one", () => {
        expect(deliveryBatch([typed("a", 1), typed("b", 2)]).map((row) => row.id)).toEqual(["a"]);
        expect(deliveryBatch([own("x", 1, "ci:1"), typed("b", 2), own("y", 3, "ci:2")]).map((row) => row.id)).toEqual(["x"]);
        expect(deliveryBatch([])).toEqual([]);
    });
});

describe("reorderedAt", () => {
    const at = (ms: number) => new Date(ms);
    const rows = [
        { id: "a", createdAt: at(1000) },
        { id: "b", createdAt: at(2000) },
        { id: "c", createdAt: at(2000) }
    ];

    it("trades places with the neighbour", () => {
        expect(reorderedAt(rows, "b", "up")).toEqual({ at: at(1000), neighbour: { id: "a", at: at(2000) } });
    });

    it("still moves past a message typed in the same millisecond", () => {
        expect(reorderedAt(rows, "b", "down")).toEqual({ at: at(2001), neighbour: { id: "c", at: at(2000) } });
    });

    it("puts a message a millisecond before the head to send it next", () => {
        expect(reorderedAt(rows, "c", "front")).toEqual({ at: at(999) });
    });

    it("does nothing at an end, at the front already, or for a message that went", () => {
        expect(reorderedAt(rows, "a", "up")).toBeNull();
        expect(reorderedAt(rows, "c", "down")).toBeNull();
        expect(reorderedAt(rows, "a", "front")).toBeNull();
        expect(reorderedAt(rows, "gone", "up")).toBeNull();
    });
});
describe("promptRoute", () => {
    const route = (state: Parameters<typeof promptRoute>[0]["state"], queued = 0, denied = 0, carried = 0) =>
        promptRoute({ state, queued, denied, carried });

    it("sends nothing more when a denial carried the words to the agent", () => {
        expect(route("waiting", 0, 1, 1)).toBe("denied");
        expect(route("waiting", 3, 2, 1)).toBe("denied");
    });

    it("steers into the turn a denial resumed, when nothing is waiting ahead", () => {
        expect(route("waiting", 0, 1, 0)).toBe("steer");
    });

    it("steers mid-turn with an empty queue, and queues behind anything waiting", () => {
        expect(route("working")).toBe("steer");
        expect(route("working", 2)).toBe("queue");
        expect(route("waiting", 1, 1, 0)).toBe("queue");
    });

    it("queues at a question nobody denied, and behind waiting messages at the prompt", () => {
        expect(route("waiting")).toBe("queue");
        expect(route("idle", 1)).toBe("queue");
    });

    it("sends at once to an agent at its prompt with nothing waiting", () => {
        expect(route("idle")).toBe("send");
    });
});

describe("queueNowRoute", () => {
    it("denies an open approval with the row, whatever the state says", () => {
        expect(queueNowRoute("working", true)).toBe("deny");
        expect(queueNowRoute("waiting", false)).toBe("deny");
    });

    it("steers mid-turn, delivers at the prompt, and interrupts otherwise", () => {
        expect(queueNowRoute("working", false)).toBe("steer");
        expect(queueNowRoute("idle", false)).toBe("deliver");
        expect(queueNowRoute("starting", false)).toBe("interrupt");
    });
});

const SESSION = { id: "s1" } as sessions.SessionView;

function reset(options: Partial<Pick<typeof fake, "steerable" | "takes" | "refusal">> = {}) {
    fake.log.length = 0;
    fake.steerable = options.steerable ?? true;
    fake.takes = options.takes ?? true;
    fake.refusal = options.refusal ?? false;
}

describe("steerPromptNow", () => {
    it("places the files before the message that names them goes, and keeps it once taken", async () => {
        reset();
        expect(await steerPromptNow(SESSION, "u1", "see this", ["f1"])).toBe(true);
        expect(fake.log).toEqual(["place /files/f1", "steer see this [/files/f1]", "keep see this [/files/f1]"]);
    });

    it("copies nothing where the turn takes no message, so the caller queues it", async () => {
        reset({ steerable: false });
        expect(await steerPromptNow(SESSION, "u1", "see this", ["f1"])).toBe(false);
        expect(fake.log).toEqual([]);
    });

    it("leaves files it cannot have to the queue to report", async () => {
        reset({ refusal: true });
        expect(await steerPromptNow(SESSION, "u1", "see this", ["f1"])).toBe(false);
        expect(fake.log).toEqual([]);
    });

    it("keeps nothing on the session when the agent did not take it", async () => {
        reset({ takes: false });
        expect(await steerPromptNow(SESSION, "u1", "plain", [])).toBe(false);
        expect(fake.log).toEqual(["steer plain"]);
    });
});

describe("steerQueuedPrompt", () => {
    const row = { text: "queued", authorId: "u1", attachments: ["f1"], createdAt: at(5), feedbackKey: null };

    function queueWith(found: typeof row | null) {
        fake.prisma = { agentQueuedPrompt: { findFirst: async () => found } };
        const back: unknown[] = [];
        const ports = {
            claim: async () => true,
            putBack: async (_sessionId: string, put: unknown) => {
                back.push(put);
            }
        };
        return { back, ports };
    }

    it("takes the row out of the queue once the agent took it", async () => {
        const { back, ports } = queueWith(row);
        expect(await steerQueuedPrompt(SESSION, "q1", ports, async () => true)).toBe(true);
        expect(back).toEqual([]);
    });

    it("puts the row back where it was, files and place kept, when the agent does not take it", async () => {
        const { back, ports } = queueWith(row);
        expect(await steerQueuedPrompt(SESSION, "q1", ports, async () => false)).toBe(false);
        expect(back).toEqual([row]);
    });

    it("puts the row back when steering throws", async () => {
        const { back, ports } = queueWith(row);
        const steer = async (): Promise<boolean> => {
            throw new Error("socket closed");
        };
        expect(await steerQueuedPrompt(SESSION, "q1", ports, steer)).toBe(false);
        expect(back).toEqual([row]);
    });

    it("does nothing for a row that already went or another delivery claimed", async () => {
        const gone = queueWith(null);
        expect(await steerQueuedPrompt(SESSION, "q1", gone.ports, async () => true)).toBe(false);
        const raced = queueWith(row);
        const lost = { ...raced.ports, claim: async () => false };
        expect(await steerQueuedPrompt(SESSION, "q1", lost, async () => true)).toBe(false);
        expect(raced.back).toEqual([]);
    });
});
