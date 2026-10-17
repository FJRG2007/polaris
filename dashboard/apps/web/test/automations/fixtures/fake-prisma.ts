/**
 * An in-memory stand-in for the Prisma calls the automations engine makes:
 * enough of `where` (equality, null, in/notIn, lt/lte/gt/gte, not, OR, AND),
 * `orderBy`, `take`/`skip`, `distinct`, unique constraints (P2002) and the one
 * relation the engine selects (`automation`). It exists so durability can be
 * tested by editing rows the way a crash would leave them.
 */

type Row = Record<string, unknown>;

const UNIQUE: Record<string, string[][]> = {
    automationRun: [["automationId", "firingKey"]],
    automationStep: [["runId", "nodeId", "iteration", "attempt"]],
    automationEvent: [["type", "dedupeKey"]],
    automationTrigger: [["automationId", "nodeId"], ["hookHash"]],
    automationVersion: [["automationId", "number"]],
    setting: [["key"]]
};

const DEFAULTS: Record<string, () => Row> = {
    automation: () => ({
        description: "",
        enabled: false,
        mode: "single",
        maxRuns: 10,
        rateLimit: 20,
        allowLocalNetwork: false,
        orgId: null,
        userId: null,
        runAsId: null,
        publishedVersionId: null,
        lastRunAt: null,
        lastStatus: null,
        tags: []
    }),
    automationRun: () => ({
        depth: 0,
        test: false,
        finally: "none",
        outcome: null,
        lockedUntil: null,
        lockToken: null,
        dueAt: null,
        stepCount: 0,
        bytes: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
        queuedAt: new Date()
    }),
    automationStep: () => ({
        iteration: "0",
        attempt: 1,
        port: null,
        input: null,
        output: null,
        error: null,
        waitUntil: null,
        waitKey: null,
        lockedUntil: null,
        startedAt: null,
        finishedAt: null
    }),
    automationEvent: () => ({
        orgId: null,
        userId: null,
        subjectKey: null,
        dedupeKey: null,
        depth: 0,
        originRunId: null,
        claimedUntil: null,
        processedAt: null
    }),
    automationTrigger: () => ({ subjectKey: null, nextDueAt: null, state: null, hookHash: null }),
    automationVersion: () => ({ name: null, savedById: null }),
    setting: () => ({}),
    placeAutomation: () => ({})
};

let counter = 0;
function nextId(): string {
    counter += 1;
    return `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`;
}

function same(a: unknown, b: unknown): boolean {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return a === b;
}

function cmp(a: unknown, b: unknown): number {
    const x = a instanceof Date ? a.getTime() : (a as number | string);
    const y = b instanceof Date ? b.getTime() : (b as number | string);
    return x < y ? -1 : x > y ? 1 : 0;
}

function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
        if (key === "OR") {
            if (!(cond as Row[]).some((part) => matches(row, part))) return false;
            continue;
        }
        if (key === "AND") {
            if (!(cond as Row[]).every((part) => matches(row, part))) return false;
            continue;
        }
        const value = row[key] ?? null;
        if (
            cond !== null &&
            typeof cond === "object" &&
            !(cond instanceof Date) &&
            !Array.isArray(cond)
        ) {
            const ops = cond as Row;
            if ("in" in ops && !(ops.in as unknown[]).some((item) => same(item, value)))
                return false;
            if ("notIn" in ops && (ops.notIn as unknown[]).some((item) => same(item, value)))
                return false;
            if ("not" in ops && same(ops.not ?? null, value)) return false;
            if ("lt" in ops && (value === null || cmp(value, ops.lt) >= 0)) return false;
            if ("lte" in ops && (value === null || cmp(value, ops.lte) > 0)) return false;
            if ("gt" in ops && (value === null || cmp(value, ops.gt) <= 0)) return false;
            if ("gte" in ops && (value === null || cmp(value, ops.gte) < 0)) return false;
            continue;
        }
        if (!same(value, cond ?? null)) return false;
    }
    return true;
}

export interface FakeDb {
    tables: Record<string, Row[]>;
    prisma: Record<string, Record<string, (args?: any) => Promise<any>>>;
    reset(): void;
}

export function createFakeDb(): FakeDb {
    const tables: Record<string, Row[]> = {};
    const table = (name: string) => (tables[name] ??= []);

    const withRelations = (name: string, row: Row, select?: Row): Row => {
        const out: Row = { ...row };
        if (select && typeof select.automation === "object" && "automationId" in row)
            out.automation = {
                ...table("automation").find((entry) => entry.id === row.automationId)
            };
        void name;
        return out;
    };

    const checkUnique = (name: string, candidate: Row, ignore?: Row) => {
        for (const fields of UNIQUE[name] ?? []) {
            if (fields.some((field) => candidate[field] === null || candidate[field] === undefined))
                continue;
            if (
                table(name).some(
                    (row) =>
                        row !== ignore &&
                        fields.every((field) => same(row[field], candidate[field]))
                )
            )
                throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
    };

    const apply = (row: Row, data: Row) => {
        for (const [key, value] of Object.entries(data)) {
            if (
                value &&
                typeof value === "object" &&
                !(value instanceof Date) &&
                "increment" in (value as Row)
            )
                row[key] = (row[key] as number) + ((value as Row).increment as number);
            else row[key] = value;
        }
    };

    const whereOf = (where: Row | undefined): Row | undefined => {
        if (!where) return where;
        const out: Row = {};
        for (const [key, value] of Object.entries(where)) {
            // Compound unique selectors: { automationId_nodeId: { ... } }.
            if (key.includes("_") && value && typeof value === "object" && !(value instanceof Date))
                Object.assign(out, value);
            else out[key] = value;
        }
        return out;
    };

    const sorted = (rows: Row[], orderBy: unknown): Row[] => {
        const orders = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Row[];
        return [...rows].sort((a, b) => {
            for (const order of orders) {
                const [key, dir] = Object.entries(order)[0]!;
                const result = cmp(a[key] ?? 0, b[key] ?? 0);
                if (result !== 0) return dir === "desc" ? -result : result;
            }
            return cmp(a.id, b.id);
        });
    };

    const model = (name: string) => ({
        findMany: async (args: any = {}) => {
            let rows = sorted(
                table(name).filter((row) => matches(row, whereOf(args.where))),
                args.orderBy
            );
            if (args.distinct) {
                const seen = new Set<string>();
                rows = rows.filter((row) => {
                    const key = (args.distinct as string[])
                        .map((field) => String(row[field]))
                        .join("|");
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            }
            rows = rows.slice(
                args.skip ?? 0,
                args.take !== undefined ? (args.skip ?? 0) + args.take : undefined
            );
            return rows.map((row) => withRelations(name, row, args.select));
        },
        findFirst: async (args: any = {}) => {
            const rows = sorted(
                table(name).filter((row) => matches(row, whereOf(args.where))),
                args.orderBy
            );
            return rows[0] ? withRelations(name, rows[0], args.select) : null;
        },
        findUnique: async (args: any) => {
            const row = table(name).find((entry) => matches(entry, whereOf(args.where)));
            return row ? withRelations(name, row, args.select) : null;
        },
        count: async (args: any = {}) =>
            table(name).filter((row) => matches(row, whereOf(args.where))).length,
        create: async (args: any) => {
            const row: Row = {
                id: nextId(),
                createdAt: new Date(),
                ...(DEFAULTS[name]?.() ?? {}),
                ...args.data
            };
            checkUnique(name, row);
            table(name).push(row);
            return { ...row };
        },
        createMany: async (args: any) => {
            let count = 0;
            for (const data of args.data as Row[]) {
                const row: Row = {
                    id: nextId(),
                    createdAt: new Date(),
                    ...(DEFAULTS[name]?.() ?? {}),
                    ...data
                };
                try {
                    checkUnique(name, row);
                } catch (caught) {
                    if (args.skipDuplicates) continue;
                    throw caught;
                }
                table(name).push(row);
                count += 1;
            }
            return { count };
        },
        update: async (args: any) => {
            const row = table(name).find((entry) => matches(entry, whereOf(args.where)));
            if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
            apply(row, args.data);
            return { ...row };
        },
        updateMany: async (args: any) => {
            const rows = table(name).filter((row) => matches(row, whereOf(args.where)));
            for (const row of rows) apply(row, args.data);
            return { count: rows.length };
        },
        upsert: async (args: any) => {
            const row = table(name).find((entry) => matches(entry, whereOf(args.where)));
            if (row) {
                apply(row, args.update);
                return { ...row };
            }
            const created: Row = {
                id: nextId(),
                createdAt: new Date(),
                ...(DEFAULTS[name]?.() ?? {}),
                ...args.create
            };
            checkUnique(name, created);
            table(name).push(created);
            return { ...created };
        },
        deleteMany: async (args: any = {}) => {
            const keep = table(name).filter((row) => !matches(row, whereOf(args.where)));
            const count = table(name).length - keep.length;
            tables[name] = keep;
            return { count };
        }
    });

    const prisma = new Proxy({} as FakeDb["prisma"], {
        get: (cache, name: string) => ((cache as Record<string, unknown>)[name] ??= model(name))
    });
    return {
        tables,
        prisma,
        reset() {
            for (const key of Object.keys(tables)) delete tables[key];
        }
    };
}
