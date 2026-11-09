import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const calls = { started: [] as unknown[], written: [] as string[], moved: [] as string[][] };

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => store.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) store.delete(key);
        else store.set(key, value);
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findMany: async () => [...store].map(([key, value]) => ({ key, value })),
            deleteMany: async ({ where }: { where: { key: string; value: string } }) => {
                if (store.get(where.key) !== where.value) return { count: 0 };
                store.delete(where.key);
                return { count: 1 };
            },
            updateMany: async ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => {
                if (store.get(where.key) !== where.value) return { count: 0 };
                store.set(where.key, data.value);
                return { count: 1 };
            },
            createMany: async ({ data }: { data: { key: string; value: string }[] }) => {
                const [row] = data;
                if (!row || store.has(row.key)) return { count: 0 };
                store.set(row.key, row.value);
                return { count: 1 };
            }
        },
        agentSession: { findFirst: async () => null, findUnique: async () => null }
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
            }
        })
}));

const spares = await import("@/lib/agents/session-spares");
const USER = "00000000-0000-4000-8000-0000000000aa";

describe("a spare session machine", () => {
    beforeEach(() => {
        store.clear();
        calls.started = [];
        calls.written = [];
        calls.moved = [];
    });

    it("is started once and kept while Code stays open", async () => {
        expect(await spares.keepSpare(USER, 1_000)).toBe(true);
        expect(await spares.keepSpare(USER, 2_000)).toBe(true);
        expect(calls.started).toHaveLength(1);
        const read = () =>
            (JSON.parse(store.get(`polar.code.spare.u.${USER}`)!) as { expiresAt: number }).expiresAt;
        // Not written again while most of its time is left...
        expect(read()).toBe(1_000 + 10 * 60_000);
        // ...and pushed back once half of it has run.
        expect(await spares.keepSpare(USER, 1_000 + 6 * 60_000)).toBe(true);
        expect(read()).toBe(1_000 + 16 * 60_000);
        expect(calls.started).toHaveLength(1);
    });

    it("is not started when an administrator switched spares off", async () => {
        store.set(spares.WARM_KEY, JSON.stringify({ enabled: false, minutes: 10, perServer: 4 }));
        expect(await spares.keepSpare(USER, 1_000)).toBe(false);
        expect(calls.started).toHaveLength(0);
    });

    it("is taken by one session only", async () => {
        await spares.keepSpare(USER, 1_000);
        const session = { place: "local", sharedHome: false, useMachineLogin: false };
        const first = await spares.takeSpare(USER, session, 2_000);
        const second = await spares.takeSpare(USER, session, 2_000);
        expect(first?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(second).toBeNull();
    });

    it("is never taken for the machine everybody shares, or once expired", async () => {
        await spares.keepSpare(USER, 1_000);
        expect(
            await spares.takeSpare(USER, { place: "local", sharedHome: true, useMachineLogin: false }, 2_000)
        ).toBeNull();
        expect(
            await spares.takeSpare(USER, { place: "local", sharedHome: false, useMachineLogin: false }, 1_000 + 11 * 60_000)
        ).toBeNull();
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
