/**
 * The edge signing key every process signs with is the one stored, even when two
 * processes create it at the same moment.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, string>();
/** Runs once, between this process reading "nothing stored" and writing its pair. */
let beforeWrite: (() => Promise<void>) | null = null;

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64") }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                rows.has(where.key) ? { value: rows.get(where.key) } : null,
            createMany: async ({ data }: { data: { key: string; value: string }[] }) => {
                const hook = beforeWrite;
                beforeWrite = null;
                await hook?.();
                let count = 0;
                for (const row of data) {
                    if (rows.has(row.key)) continue;
                    rows.set(row.key, row.value);
                    count += 1;
                }
                return { count };
            },
            updateMany: async ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => {
                const hook = beforeWrite;
                beforeWrite = null;
                await hook?.();
                if (rows.get(where.key) !== where.value) return { count: 0 };
                rows.set(where.key, data.value);
                return { count: 1 };
            }
        }
    }
}));

async function freshProcess() {
    vi.resetModules();
    return import("@/lib/edge-signing-key");
}

beforeEach(() => {
    rows.clear();
    beforeWrite = null;
});

describe("the edge signing key", () => {
    it("is created once and read back by every later process", async () => {
        const first = await (await freshProcess()).edgeSigningKey();
        const second = await (await freshProcess()).edgeSigningKey();

        expect(second.publicKey).toBe(first.publicKey);
    });

    it("converges on the stored pair when another process creates it first", async () => {
        const other = await freshProcess();
        const seen: { first?: { publicKey: string } } = {};
        beforeWrite = async () => {
            beforeWrite = null;
            seen.first = await other.edgeSigningKey();
        };
        const second = await (await freshProcess()).edgeSigningKey();
        const stored = await (await freshProcess()).edgeSigningKey();

        expect(seen.first?.publicKey).toBe(stored.publicKey);
        expect(second.publicKey).toBe(stored.publicKey);
    });

    it("replaces an unreadable key only once, even when two processes see it", async () => {
        rows.set("edge.signing.ed25519", "not a sealed key");
        const other = await freshProcess();
        const seen: { first?: { publicKey: string } } = {};
        beforeWrite = async () => {
            beforeWrite = null;
            seen.first = await other.edgeSigningKey();
        };
        const second = await (await freshProcess()).edgeSigningKey();
        const stored = await (await freshProcess()).edgeSigningKey();

        expect(seen.first?.publicKey).toBe(stored.publicKey);
        expect(second.publicKey).toBe(stored.publicKey);
    });
});
