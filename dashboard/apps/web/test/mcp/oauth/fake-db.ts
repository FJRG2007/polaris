/**
 * An in-memory stand-in for the four OAuth tables and the user rows they point
 * at, implementing exactly the Prisma calls `lib/mcp/oauth` makes. Enough to run
 * the whole flow - register, approve, exchange, call, refresh, replay, revoke -
 * without a database, and strict enough that a query this does not understand
 * throws rather than quietly matching everything.
 */

import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;

export interface FakeUser {
    id: string;
    name: string;
    email: string;
    username: string | null;
    isAdmin: boolean;
    bannedAt: Date | null;
}

function matches(row: Row, where: Row | undefined, relations: (row: Row) => Row): boolean {
    if (!where) return true;
    for (const [key, condition] of Object.entries(where)) {
        if (key === "OR") {
            if (!(condition as Row[]).some((branch) => matches(row, branch, relations)))
                return false;
            continue;
        }
        if (key === "AND") {
            if (!(condition as Row[]).every((branch) => matches(row, branch, relations)))
                return false;
            continue;
        }
        if (key === "userId_clientId") {
            const pair = condition as { userId: string; clientId: string };
            if (row.userId !== pair.userId || row.clientId !== pair.clientId) return false;
            continue;
        }
        if (key === "grants") {
            const related = relations(row).grants as Row[];
            if ((condition as Row).none === undefined)
                throw new Error("fake-db: unsupported grants filter");
            if (related.length > 0) return false;
            continue;
        }
        const value = row[key];
        if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
            const ops = condition as Row;
            for (const [op, operand] of Object.entries(ops)) {
                if (op === "lt") {
                    if (
                        !(value instanceof Date) ||
                        !(value.getTime() < (operand as Date).getTime())
                    )
                        return false;
                } else if (op === "gt") {
                    if (
                        !(value instanceof Date) ||
                        !(value.getTime() > (operand as Date).getTime())
                    )
                        return false;
                } else if (op === "in") {
                    if (!(operand as unknown[]).includes(value)) return false;
                } else {
                    throw new Error(`fake-db: unsupported operator ${op}`);
                }
            }
            continue;
        }
        if (condition instanceof Date) {
            if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
            continue;
        }
        if ((value ?? null) !== condition) return false;
    }
    return true;
}

export function createFakeDb(users: FakeUser[]) {
    const tables: Record<string, Row[]> = {
        oAuthClient: [],
        oAuthGrant: [],
        oAuthCode: [],
        oAuthToken: [],
        session: []
    };

    function relationsOf(model: string, row: Row): Row {
        if (model === "oAuthClient") {
            return { grants: tables.oAuthGrant!.filter((grant) => grant.clientId === row.id) };
        }
        if (model === "oAuthGrant") {
            return {
                user: users.find((user) => user.id === row.userId),
                client: tables.oAuthClient!.find((client) => client.id === row.clientId)
            };
        }
        const grant = tables.oAuthGrant!.find((entry) => entry.id === row.grantId);
        return { grant: grant ? { ...grant, ...relationsOf("oAuthGrant", grant) } : undefined };
    }

    function view(model: string, row: Row | undefined): Row | null {
        return row ? { ...row, ...relationsOf(model, row) } : null;
    }

    function defaults(model: string, data: Row): Row {
        const now = new Date();
        const base: Row = { id: randomUUID(), createdAt: now };
        if (model === "oAuthClient")
            Object.assign(base, {
                clientUri: null,
                secretHash: null,
                fetchedAt: null,
                redirectUris: "[]",
                tokenAuthMethod: "none",
                source: "registered"
            });
        if (model === "oAuthGrant")
            Object.assign(base, {
                scopes: "[]",
                lastUsedAt: null,
                lastUsedIp: null,
                revokedAt: null,
                updatedAt: now
            });
        if (model === "oAuthCode" || model === "oAuthToken")
            Object.assign(base, { usedAt: null, scopes: "[]" });
        return { ...base, ...data };
    }

    function unique(model: string, data: Row): void {
        const keys: Record<string, string[]> = {
            oAuthClient: ["clientId"],
            oAuthCode: ["codeHash"],
            oAuthToken: ["tokenHash"]
        };
        for (const key of keys[model] ?? []) {
            if (tables[model]!.some((row) => row[key] === data[key]))
                throw new Error(`fake-db: unique ${model}.${key}`);
        }
    }

    function delegate(model: string) {
        const rows = () => tables[model]!;
        const relations = (row: Row) => relationsOf(model, row);
        return {
            async findUnique({ where }: { where: Row }) {
                return view(
                    model,
                    rows().find((row) => matches(row, where, relations))
                );
            },
            async findFirst({ where }: { where: Row }) {
                return view(
                    model,
                    rows().find((row) => matches(row, where, relations))
                );
            },
            async findMany({ where, take }: { where?: Row; take?: number }) {
                const found = rows().filter((row) => matches(row, where, relations));
                return found.slice(0, take ?? found.length).map((row) => view(model, row)!);
            },
            async create({ data }: { data: Row }) {
                unique(model, data);
                const row = defaults(model, data);
                rows().push(row);
                return view(model, row);
            },
            async upsert({ where, create, update }: { where: Row; create: Row; update: Row }) {
                const found = rows().find((row) => matches(row, where, relations));
                if (found) {
                    Object.assign(
                        found,
                        update,
                        model === "oAuthGrant" ? { updatedAt: new Date() } : {}
                    );
                    return view(model, found);
                }
                const row = defaults(model, create);
                rows().push(row);
                return view(model, row);
            },
            async update({ where, data }: { where: Row; data: Row }) {
                const found = rows().find((row) => matches(row, where, relations));
                if (!found) throw new Error(`fake-db: ${model}.update found nothing`);
                Object.assign(found, data);
                return view(model, found);
            },
            async updateMany({ where, data }: { where: Row; data: Row }) {
                const found = rows().filter((row) => matches(row, where, relations));
                for (const row of found) Object.assign(row, data);
                return { count: found.length };
            },
            async deleteMany({ where }: { where?: Row }) {
                const keep = rows().filter((row) => !matches(row, where, relations));
                const count = rows().length - keep.length;
                tables[model] = keep;
                return { count };
            }
        };
    }

    const prisma = {
        oAuthClient: delegate("oAuthClient"),
        oAuthGrant: delegate("oAuthGrant"),
        oAuthCode: delegate("oAuthCode"),
        oAuthToken: delegate("oAuthToken"),
        session: delegate("session"),
        user: {
            async findUnique({ where }: { where: { id: string } }) {
                return users.find((user) => user.id === where.id) ?? null;
            }
        },
        async $transaction(operations: Promise<unknown>[]) {
            const results: unknown[] = [];
            for (const operation of operations) results.push(await operation);
            return results;
        }
    };

    return { prisma, tables };
}
