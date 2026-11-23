/**
 * The chat MLS tables as an in-memory stand-in with the semantics the
 * delivery service relies on: unique keys, `updateMany` counts, and
 * all-or-nothing transactions run one at a time (Postgres's row lock on the
 * group does the same for two commits). Used from a `vi.mock("@polaris/db")`
 * factory, over the test's own hoisted state.
 */

type Row = Record<string, unknown>;

export interface MemoryTablesState {
    tables: Record<string, Row[]>;
    seq: bigint;
}

export function memoryPrisma(state: MemoryTablesState) {
    const same = (a: unknown, b: unknown) =>
        a instanceof Uint8Array && b instanceof Uint8Array ? Buffer.from(a).equals(Buffer.from(b)) : a === b;
    const matches = (row: Row, where: Row = {}): boolean =>
        Object.entries(where).every(([key, want]) => {
            if (key === "OR") return (want as Row[]).some((w) => matches(row, w));
            if (key === "userId_device") return matches(row, want as Row);
            if (want && typeof want === "object" && !(want instanceof Uint8Array)) {
                const cond = want as { in?: unknown[]; gt?: bigint; gte?: bigint; lt?: bigint };
                if (cond.in) return cond.in.some((value) => same(row[key], value));
                if (cond.gt !== undefined) return (row[key] as bigint) > cond.gt;
                if (cond.gte !== undefined) return (row[key] as bigint) >= cond.gte;
                if (cond.lt !== undefined) return (row[key] as bigint) < cond.lt;
            }
            return same(row[key] ?? null, want);
        });
    const table = (name: string, keys: string[]) => {
        const rows = () => (state.tables[name] ??= []);
        const unique = (data: Row) => {
            if (keys.length && rows().some((r) => keys.every((k) => same(r[k], data[k])))) throw new Error("unique violation");
        };
        const fill = (data: Row) => ({
            ...(name === "mlsGroupEvent" ? { seq: ++state.seq, recipient: null } : {}),
            ...(name === "mlsKeyPackage" ? { id: crypto.randomUUID(), createdAt: new Date(Date.now() + rows().length) } : {}),
            ...(name === "chatMessage" ? { id: crypto.randomUUID(), createdAt: new Date() } : {}),
            ...data
        });
        return {
            findUnique: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
            findFirst: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
            findMany: async ({ where, take }: { where: Row; take?: number }) =>
                rows()
                    .filter((r) => matches(r, where))
                    .slice(0, take ?? Infinity),
            count: async ({ where }: { where: Row }) => rows().filter((r) => matches(r, where)).length,
            create: async ({ data }: { data: Row }) => {
                unique(data);
                const row = fill(data);
                rows().push(row);
                return row;
            },
            update: async ({ where, data }: { where: Row; data: Row }) => {
                const row = rows().find((r) => matches(r, where));
                if (!row) throw new Error("record not found");
                for (const [key, value] of Object.entries(data))
                    row[key] = value && typeof value === "object" && "increment" in value ? ((row[key] as number) ?? 0) + (value as { increment: number }).increment : value;
                return row;
            },
            createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
                for (const d of data) {
                    try {
                        unique(d);
                    } catch (error) {
                        if (skipDuplicates) continue;
                        throw error;
                    }
                    rows().push(fill(d));
                }
            },
            upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
                const row = rows().find((r) => matches(r, where));
                if (row) Object.assign(row, update);
                else rows().push(fill(create));
            },
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                const hit = rows().filter((r) => matches(r, where));
                for (const r of hit) Object.assign(r, data);
                return { count: hit.length };
            },
            deleteMany: async ({ where }: { where: Row }) => {
                const before = rows().length;
                state.tables[name] = rows().filter((r) => !matches(r, where));
                return { count: before - state.tables[name].length };
            }
        };
    };
    let queue: Promise<unknown> = Promise.resolve();
    const prisma = {
        mlsDevice: table("mlsDevice", ["userId", "device"]),
        mlsKeyPackage: table("mlsKeyPackage", []),
        mlsGroup: table("mlsGroup", ["channelId"]),
        mlsGroupEvent: table("mlsGroupEvent", []),
        chatHistoryKey: table("chatHistoryKey", ["channelId", "epoch", "recipient"]),
        chatAccountKey: table("chatAccountKey", ["userId"]),
        chatMessage: table("chatMessage", []),
        chatChannel: table("chatChannel", ["id"]),
        chatWebhook: table("chatWebhook", ["id"]),
        mlsStoreEntry: table("mlsStoreEntry", ["device", "key"]),
        // All or nothing, one at a time (Postgres's row lock on the group does
        // the same for two commits): run on the live tables, put the copy back
        // on a throw.
        // The array form takes operations that already ran (these are eager): it only waits for them.
        $transaction: (fn: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[]) => {
            if (Array.isArray(fn)) return Promise.all(fn);
            const run = queue.then(async () => {
                const snapshot = structuredClone(state.tables);
                try {
                    return await fn(prisma);
                } catch (error) {
                    state.tables = snapshot;
                    throw error;
                }
            });
            queue = run.catch(() => undefined);
            return run;
        }
    };
    return prisma;
}
