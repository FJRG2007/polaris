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
            if (key === "AND") return (want as Row[]).every((w) => matches(row, w));
            if (key === "userId_device" || key === "channelId_service" || key === "channelId_epoch_sender_part") return matches(row, want as Row);
            if (want && typeof want === "object" && !(want instanceof Uint8Array)) {
                const cond = want as { in?: unknown[]; gt?: bigint; gte?: bigint; lt?: bigint; lte?: bigint; not?: unknown; isEmpty?: boolean; equals?: unknown };
                if (cond.in) return cond.in.some((value) => same(row[key], value));
                if ("equals" in cond) return same(row[key] ?? null, cond.equals ?? null);
                if (cond.isEmpty !== undefined) return ((row[key] as unknown[] | undefined) ?? []).length === 0 === cond.isEmpty;
                if ("not" in cond) return !same(row[key] ?? null, cond.not);
                const value = row[key] as bigint;
                if (cond.gt !== undefined || cond.gte !== undefined || cond.lt !== undefined || cond.lte !== undefined)
                    return (
                        (cond.gt === undefined || value > cond.gt) &&
                        (cond.gte === undefined || value >= cond.gte) &&
                        (cond.lt === undefined || value < cond.lt) &&
                        (cond.lte === undefined || value <= cond.lte)
                    );
            }
            return same(row[key] ?? null, want);
        });
    // A single-column numeric `orderBy` is honoured; anything else keeps the rows in the order they were written.
    const ordered = (found: Row[], orderBy: unknown): Row[] => {
        const entries = orderBy && typeof orderBy === "object" && !Array.isArray(orderBy) ? Object.entries(orderBy as Row) : [];
        if (entries.length !== 1) return found;
        const [column, direction] = entries[0]!;
        const numeric = (value: unknown) => typeof value === "bigint" || typeof value === "number";
        if (!found.every((r) => numeric(r[column]))) return found;
        const sign = direction === "desc" ? -1 : 1;
        return [...found].sort((a, b) => ((a[column] as bigint) < (b[column] as bigint) ? -sign : (a[column] as bigint) > (b[column] as bigint) ? sign : 0));
    };
    const copy = (row: Row | undefined): Row | null => (row ? { ...row } : null);
    const table = (name: string, keys: string[]) => {
        const rows = () => (state.tables[name] ??= []);
        const unique = (data: Row) => {
            if (keys.length && rows().some((r) => keys.every((k) => same(r[k], data[k])))) throw new Error("unique violation");
        };
        const fill = (data: Row) => ({
            ...(name === "mlsGroupEvent" ? { seq: ++state.seq, recipient: null } : {}),
            ...(name === "mlsKeyPackage" ? { id: crypto.randomUUID(), createdAt: new Date(Date.now() + rows().length) } : {}),
            ...(name === "chatMessage" ? { id: crypto.randomUUID(), createdAt: new Date() } : {}),
            ...(name === "chatSearchSegment" ? { createdAt: new Date(Date.now() + rows().length) } : {}),
            ...data
        });
        return {
            // Reads hand out copies, as Prisma does: a later write never reaches a row already read.
            findUnique: async ({ where }: { where: Row }) => copy(rows().find((r) => matches(r, where))),
            findFirst: async ({ where }: { where: Row }) => copy(rows().find((r) => matches(r, where))),
            findMany: async ({ where, take, orderBy }: { where: Row; take?: number; orderBy?: unknown }) =>
                ordered(rows().filter((r) => matches(r, where)), orderBy)
                    .slice(0, take ?? Infinity)
                    .map((r) => ({ ...r })),
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
                if (row) return Object.assign(row, update);
                const created = fill(create);
                rows().push(created);
                return created;
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
        // Read by `conversationSealed` (a conversation the migration cut is sealed only).
        chatMigration: table("chatMigration", ["channelId"]),
        mlsGroupEvent: table("mlsGroupEvent", []),
        mlsTreePart: table("mlsTreePart", ["channelId", "epoch", "sender", "part"]),
        chatHistoryKey: table("chatHistoryKey", ["channelId", "epoch", "recipient"]),
        chatAccountKey: table("chatAccountKey", ["userId"]),
        chatMessage: table("chatMessage", []),
        chatMessageEdit: table("chatMessageEdit", []),
        chatChannel: table("chatChannel", ["id"]),
        chatWebhook: table("chatWebhook", ["id"]),
        mlsStoreEntry: table("mlsStoreEntry", ["device", "key"]),
        chatServiceMember: table("chatServiceMember", ["channelId", "service"]),
        user: table("user", ["id"]),
        setting: table("setting", ["key"]),
        // Read by `inactiveCutoffs` (an organization's tighter device limit).
        organizationMember: table("organizationMember", ["orgId", "userId"]),
        organization: table("organization", ["id"]),
        // Shared search segments and who builds them (`search-segments-service.ts`).
        chatSearchSegment: table("chatSearchSegment", ["channelId", "epoch", "seq", "generation"]),
        chatSearchLease: table("chatSearchLease", ["channelId", "epoch", "seq"]),
        chatMigrationRollback: table("chatMigrationRollback", ["kind", "id"]),
        // Who a migration asks on behalf of (`legacy-migration.ts audienceOf`).
        chatChannelMember: table("chatChannelMember", ["channelId", "userId"]),
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
