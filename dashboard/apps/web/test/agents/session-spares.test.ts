import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    userId: string;
    sessionId: string;
    hostId: string | null;
    expiresAt: Date;
    createdAt?: Date;
}

const settings = new Map<string, string>();
const spareRows = new Map<string, Row>();
const sessions = new Set<string>();
const calls = {
    started: [] as unknown[],
    written: [] as string[],
    moved: [] as string[][],
    down: [] as string[]
};

type Where = { userId?: string; sessionId?: string | { in: string[] }; expiresAt?: { lte?: Date; gt?: Date } };

function matches(row: Row, where: Where): boolean {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (typeof where.sessionId === "string" && row.sessionId !== where.sessionId) return false;
    if (typeof where.sessionId === "object" && !where.sessionId.in.includes(row.sessionId)) return false;
    if (where.expiresAt?.lte && row.expiresAt > where.expiresAt.lte) return false;
    if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) return false;
    return true;
}

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findMany: async ({ where }: { where: { key: { startsWith: string } } }) =>
                [...settings]
                    .filter(([key]) => key.startsWith(where.key.startsWith))
                    .map(([key, value]) => ({ key, value })),
            deleteMany: async ({ where }: { where: { key: string } }) => ({
                count: settings.delete(where.key) ? 1 : 0
            })
        },
        agentSpare: {
            findUnique: async ({ where }: { where: { userId: string } }) => spareRows.get(where.userId) ?? null,
            findMany: async ({ where }: { where: Where }) => [...spareRows.values()].filter((row) => matches(row, where)),
            groupBy: async ({ where }: { where: Where }) => {
                const counts = new Map<string | null, number>();
                for (const row of spareRows.values()) {
                    if (matches(row, where)) counts.set(row.hostId, (counts.get(row.hostId) ?? 0) + 1);
                }
                return [...counts].map(([hostId, n]) => ({ hostId, _count: { _all: n } }));
            },
            createMany: async ({ data }: { data: Row[] }) => {
                const [row] = data;
                if (!row || spareRows.has(row.userId)) return { count: 0 };
                spareRows.set(row.userId, { ...row });
                return { count: 1 };
            },
            updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
                const row = spareRows.get(where.userId!);
                if (!row || !matches(row, where)) return { count: 0 };
                spareRows.set(row.userId, { ...row, ...data });
                return { count: 1 };
            },
            deleteMany: async ({ where }: { where: Where }) => {
                const row = spareRows.get(where.userId!);
                if (!row || !matches(row, where)) return { count: 0 };
                spareRows.delete(row.userId);
                return { count: 1 };
            }
        },
        agentSession: {
            findFirst: async () => null,
            findUnique: async ({ where }: { where: { id: string } }) => (sessions.has(where.id) ? { id: where.id } : null)
        }
    }
}));
vi.mock("@/lib/agents/session-container", () => ({
    startContainer: async (...args: unknown[]) => {
        calls.started.push(args);
    }
}));
vi.mock("@/lib/agents/session-capacity", () => ({ totalCeiling: async () => 12 }));
vi.mock("@/lib/agents/session-placement", () => ({
    readPool: async () => ({ box: true, servers: [] }),
    poolCandidates: async () => [{ hostId: null, ceiling: 12, live: 0 }],
    choosePlacement: (candidates: { hostId: string | null }[]) => candidates[0]?.hostId
}));
vi.mock("@/lib/agents/session-ports", () => ({
    containerState: async () => "running",
    withContainerPorts: async (_host: string | null, work: (ports: unknown) => Promise<unknown>) =>
        work({
            writeFile: async (_name: string, path: string, stream: AsyncIterable<Buffer>) => {
                let text = "";
                for await (const chunk of stream) text += chunk.toString("utf8");
                calls.written.push(`${path}\n${text}`);
            },
            runIn: async (_name: string, argv: string[]) => {
                calls.moved.push(argv);
                return { code: 0, output: "" };
            },
            composeDown: async (name: string) => {
                calls.down.push(name);
            }
        })
}));

const spares = await import("@/lib/agents/session-spares");
const USER = "00000000-0000-4000-8000-0000000000aa";
const LOCAL = { place: "local", sharedHome: false, useMachineLogin: false };

describe("a spare session machine", () => {
    beforeEach(() => {
        settings.clear();
        spareRows.clear();
        sessions.clear();
        calls.started = [];
        calls.written = [];
        calls.moved = [];
        calls.down = [];
    });

    it("is started once and kept while Code stays open", async () => {
        expect(await spares.keepSpare(USER, 1_000)).toBe(true);
        expect(await spares.keepSpare(USER, 2_000)).toBe(true);
        expect(calls.started).toHaveLength(1);
        const read = () => spareRows.get(USER)!.expiresAt.getTime();
        // Not written again while most of its time is left...
        expect(read()).toBe(1_000 + 10 * 60_000);
        // ...and pushed back once half of it has run.
        expect(await spares.keepSpare(USER, 1_000 + 6 * 60_000)).toBe(true);
        expect(read()).toBe(1_000 + 16 * 60_000);
        expect(calls.started).toHaveLength(1);
    });

    it("is not started when an administrator switched spares off", async () => {
        settings.set(spares.WARM_KEY, JSON.stringify({ enabled: false, minutes: 10, perServer: 4 }));
        expect(await spares.keepSpare(USER, 1_000)).toBe(false);
        expect(calls.started).toHaveLength(0);
    });

    it("is not started on a server already holding as many as it may", async () => {
        settings.set(spares.WARM_KEY, JSON.stringify({ enabled: true, minutes: 10, perServer: 1 }));
        spareRows.set("other", {
            userId: "other",
            sessionId: "00000000-0000-4000-8000-0000000000cc",
            hostId: null,
            expiresAt: new Date(10 * 60_000)
        });
        expect(await spares.keepSpare(USER, 1_000)).toBe(false);
        expect(calls.started).toHaveLength(0);
    });

    it("is taken by one session only", async () => {
        await spares.keepSpare(USER, 1_000);
        const first = await spares.takeSpare(USER, LOCAL, 2_000);
        const second = await spares.takeSpare(USER, LOCAL, 2_000);
        expect(first?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(second).toBeNull();
    });

    it("is never taken for the machine everybody shares, or once expired", async () => {
        await spares.keepSpare(USER, 1_000);
        expect(await spares.takeSpare(USER, { ...LOCAL, sharedHome: true }, 2_000)).toBeNull();
        expect(await spares.takeSpare(USER, LOCAL, 1_000 + 11 * 60_000)).toBeNull();
    });

    it("is swept with its container once expired, unless a session was made of it", async () => {
        await spares.keepSpare(USER, 1_000);
        const unused = spareRows.get(USER)!.sessionId;
        expect(await spares.sweepSpares(2_000)).toBe(0);
        expect(await spares.sweepSpares(1_000 + 11 * 60_000)).toBe(1);
        expect(calls.down).toEqual([`polaris-session-${unused}`]);
        expect(spareRows.size).toBe(0);

        await spares.keepSpare(USER, 20 * 60_000);
        sessions.add(spareRows.get(USER)!.sessionId);
        expect(await spares.sweepSpares(40 * 60_000)).toBe(1);
        expect(calls.down).toHaveLength(1);
    });

    it("takes down the reservations kept before the table, with their containers", async () => {
        const id = "00000000-0000-4000-8000-0000000000dd";
        settings.set(`polar.code.spare.u.${USER}`, JSON.stringify({ id, hostId: null, expiresAt: 5 }));
        await spares.sweepSpares(1_000);
        expect(calls.down).toEqual([`polaris-session-${id}`]);
        expect(settings.has(`polar.code.spare.u.${USER}`)).toBe(false);
    });

    it("names only the waiting spares among the containers asked about", async () => {
        await spares.keepSpare(USER, 1_000);
        const id = spareRows.get(USER)!.sessionId;
        const found = await spares.reservedSpareIds([id, "00000000-0000-4000-8000-0000000000ee"]);
        expect([...found]).toEqual([id]);
        expect((await spares.reservedSpareIds([])).size).toBe(0);
    });

    it("hands the session over as a quoted file, moved into place whole", async () => {
        const claimed = await spares.claimSpare(
            { id: "00000000-0000-4000-8000-0000000000bb", hostId: null },
            { POLARIS_TMUX: "polaris", POLARIS_PROMPT: "it's" }
        );
        expect(claimed).toBe(true);
        expect(calls.written[0]).toBe(
            "/session/claim.env.part\nPOLARIS_TMUX='polaris'\nPOLARIS_PROMPT='it'\\''s'\n"
        );
        expect(calls.moved[0]?.[2]).toBe(
            "chmod 0600 /session/claim.env.part && mv /session/claim.env.part /session/claim.env"
        );
    });
});
