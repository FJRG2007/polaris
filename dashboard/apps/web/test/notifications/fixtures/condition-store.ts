/**
 * An in-memory stand-in for the Notification table that does what the real one
 * does for conditions: (userId, conditionKey) is unique while the key is set,
 * and a second create for it fails with Prisma's P2002. Every call yields once
 * first, so two callers started together really do interleave.
 */

export interface StoredNotice {
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string | null;
    level: string;
    actionRequired: boolean;
    metadata: string | null;
    conditionKey: string | null;
    readAt: Date | null;
    updatedAt: Date | null;
}

type Where = { userId?: string | { in: string[] }; conditionKey?: string | { startsWith: string } };

function matches(row: StoredNotice, where: Where): boolean {
    if (typeof where.userId === "string" && row.userId !== where.userId) return false;
    if (typeof where.userId === "object" && !where.userId.in.includes(row.userId)) return false;
    if (typeof where.conditionKey === "string" && row.conditionKey !== where.conditionKey) return false;
    if (typeof where.conditionKey === "object" && !(row.conditionKey ?? "").startsWith(where.conditionKey.startsWith)) {
        return false;
    }
    return true;
}

export function conditionStore() {
    const rows: StoredNotice[] = [];
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const notification = {
        updateMany: async ({ where, data }: { where: Where; data: Partial<StoredNotice> }) => {
            await tick();
            const hit = rows.filter((row) => matches(row, where));
            for (const row of hit) Object.assign(row, data);
            return { count: hit.length };
        },
        create: async ({ data }: { data: Omit<StoredNotice, "id" | "updatedAt"> }) => {
            await tick();
            if (data.conditionKey && rows.some((row) => row.userId === data.userId && row.conditionKey === data.conditionKey)) {
                throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
            }
            const row = { ...data, id: `n${rows.length + 1}`, updatedAt: null } as StoredNotice;
            rows.push(row);
            return row;
        },
        findMany: async ({ where }: { where: Where }) => {
            await tick();
            return rows.filter((row) => matches(row, where));
        }
    };
    return { rows, notification };
}
