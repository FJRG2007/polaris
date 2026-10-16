/**
 * An in-memory stand-in for the tables the rollout service touches, answering
 * the subset of Prisma's query shapes it uses: equality, `in`, `notIn`, `not`,
 * `lt`, `lte`, `gt`, `increment`, a `rollout` relation filter and unique keys that refuse a
 * second row. Enough to run the service's real conditional writes end to end.
 */

import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;

const UNIQUE: Record<string, string[]> = {
    serverCommand: ["id"],
    serverAgent: ["serverId"],
    agentRollout: ["id", "openKey"],
    agentRolloutTarget: ["id"],
    host: ["id"],
    hostTemplateAssignment: ["id"]
};

const DEFAULTS: Record<string, () => Row> = {
    serverCommand: () => ({
        status: "queued",
        attempts: 0,
        result: null,
        startedAt: null,
        finishedAt: null,
        payload: "{}",
        createdAt: new Date()
    }),
    serverAgent: () => ({ version: null, heartbeatAt: null, pinnedVersion: null }),
    agentRollout: () => ({
        status: "running",
        wave: 0,
        haltReason: null,
        previousVersion: null,
        finishedAt: null,
        createdAt: new Date()
    }),
    agentRolloutTarget: () => ({
        state: "pending",
        error: null,
        startedAt: null,
        healthySince: null,
        finishedAt: null,
        fromVersion: null
    })
};

export function createFakeDb() {
    const tables: Record<string, Row[]> = {
        serverCommand: [],
        serverAgent: [],
        agentRollout: [],
        agentRolloutTarget: [],
        host: [],
        hostTemplateAssignment: []
    };

    function compare(
        value: unknown,
        condition: unknown,
        row: Row,
        table: string,
        key: string
    ): boolean {
        if (table === "agentRolloutTarget" && key === "rollout") {
            const parent = tables.agentRollout!.find((one) => one.id === row.rolloutId);
            return parent !== undefined && matches(parent, condition as Row, "agentRollout");
        }
        if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
            const ops = condition as Record<string, unknown>;
            if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
            if ("notIn" in ops && (ops.notIn as unknown[]).includes(value)) return false;
            if ("not" in ops && value === ops.not) return false;
            if (
                "lt" in ops &&
                !(value != null && (value as Date | number) < (ops.lt as Date | number))
            )
                return false;
            if ("lte" in ops && !((value as Date | number) <= (ops.lte as Date | number)))
                return false;
            if ("gt" in ops && !((value as Date | number) > (ops.gt as Date | number)))
                return false;
            return true;
        }
        return value === condition;
    }

    function matches(row: Row, where: Row | undefined, table: string): boolean {
        return Object.entries(where ?? {}).every(([key, condition]) =>
            compare(row[key], condition, row, table, key)
        );
    }

    function apply(row: Row, data: Row): void {
        for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && "increment" in (value as Row)) {
                row[key] = (row[key] as number) + (value as { increment: number }).increment;
            } else row[key] = value;
        }
    }

    function order(rows: Row[], orderBy: unknown): Row[] {
        const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<
            string,
            "asc" | "desc"
        >[];
        return [...rows].sort((a, b) => {
            for (const entry of keys) {
                const [key, direction] = Object.entries(entry)[0]!;
                const x = a[key] as number | string | Date;
                const y = b[key] as number | string | Date;
                if (x < y) return direction === "asc" ? -1 : 1;
                if (x > y) return direction === "asc" ? 1 : -1;
            }
            return 0;
        });
    }

    function insert(table: string, data: Row): Row {
        const { targets, ...rest } = data as Row & { targets?: { create: Row[] } };
        const row: Row = { id: randomUUID(), ...DEFAULTS[table]?.(), ...rest };
        for (const key of UNIQUE[table] ?? []) {
            if (row[key] != null && tables[table]!.some((one) => one[key] === row[key])) {
                throw Object.assign(new Error(`Unique constraint failed on ${table}.${key}`), {
                    code: "P2002"
                });
            }
        }
        tables[table]!.push(row);
        for (const target of targets?.create ?? []) {
            insert("agentRolloutTarget", { ...target, rolloutId: row.id });
        }
        return { ...row };
    }

    function model(table: string) {
        const rows = () => tables[table]!;
        return {
            findUnique: async ({ where }: { where: Row }) => {
                const found = rows().find((row) => matches(row, where, table));
                return found ? { ...found } : null;
            },
            findFirst: async (args: { where?: Row; orderBy?: unknown; include?: Row } = {}) => {
                const found = order(
                    rows().filter((row) => matches(row, args.where, table)),
                    args.orderBy
                )[0];
                if (!found) return null;
                if (args.include?.targets) {
                    return {
                        ...found,
                        targets: order(
                            tables.agentRolloutTarget!.filter((one) => one.rolloutId === found.id),
                            (args.include.targets as { orderBy?: unknown }).orderBy
                        )
                    };
                }
                return { ...found };
            },
            findMany: async (args: { where?: Row; orderBy?: unknown; take?: number } = {}) =>
                order(
                    rows().filter((row) => matches(row, args.where, table)),
                    args.orderBy
                )
                    .slice(0, args.take ?? Infinity)
                    .map((row) => ({ ...row })),
            count: async ({ where }: { where?: Row } = {}) =>
                rows().filter((row) => matches(row, where, table)).length,
            create: async ({ data }: { data: Row }) => insert(table, data),
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                const hit = rows().filter((row) => matches(row, where, table));
                hit.forEach((row) => apply(row, data));
                return { count: hit.length };
            },
            deleteMany: async ({ where }: { where?: Row } = {}) => {
                const keep = rows().filter((row) => !matches(row, where, table));
                const count = rows().length - keep.length;
                tables[table]!.splice(0, rows().length, ...keep);
                if (table === "agentRollout") {
                    const live = new Set(keep.map((row) => row.id));
                    const targets = tables.agentRolloutTarget!.filter((row) =>
                        live.has(row.rolloutId)
                    );
                    tables.agentRolloutTarget!.splice(
                        0,
                        tables.agentRolloutTarget!.length,
                        ...targets
                    );
                }
                return { count };
            },
            upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
                const found = rows().find((row) => matches(row, where, table));
                if (found) {
                    apply(found, update);
                    return { ...found };
                }
                return insert(table, create);
            },
            groupBy: async ({ by, where }: { by: string[]; where?: Row }) => {
                const seen = new Map<string, Row>();
                for (const row of rows().filter((one) => matches(one, where, table))) {
                    const key = by.map((field) => String(row[field])).join("|");
                    if (!seen.has(key))
                        seen.set(key, Object.fromEntries(by.map((field) => [field, row[field]])));
                }
                return [...seen.values()];
            }
        };
    }

    const prisma = {
        serverCommand: model("serverCommand"),
        serverAgent: model("serverAgent"),
        agentRollout: model("agentRollout"),
        agentRolloutTarget: model("agentRolloutTarget"),
        host: model("host"),
        hostTemplateAssignment: model("hostTemplateAssignment"),
        $transaction: async (work: Promise<unknown>[]) => Promise.all(work)
    };
    return {
        prisma,
        tables,
        reset() {
            for (const key of Object.keys(tables)) tables[key]!.length = 0;
        }
    };
}

/** One shared instance, so a mocked `@polaris/db` and the test see the same rows. */
export const fakeDb = createFakeDb();
