/**
 * An in-memory Prisma for the Calendar's server code.
 *
 * Holds rows per model and answers the part of the Prisma client the Calendar
 * modules use: reads with `where`, `select` (nested relations and `_count`),
 * `orderBy`, `take` and `skip`; writes with defaults, `@updatedAt`, unique keys
 * (compound ones included) and the schema's cascading deletes; and
 * `$transaction` in both forms.
 *
 * It is strict on purpose. An operator, a field or a relation it does not know
 * throws instead of matching, so a test can never pass because the fake ignored
 * a filter the real database would have applied.
 */

import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;

type Kind = "one" | "many";

interface Relation {
    readonly model: string;
    readonly kind: Kind;
    /** The field on this model (one) or on the other model (many) holding the key. */
    readonly foreignKey: string;
    /** The field the key points at. */
    readonly references: string;
    /** Deleting a row of this model deletes the related rows (many) - the schema's `onDelete: Cascade`. */
    readonly cascade?: boolean;
}

interface Model {
    /** Every scalar field and its default (a function is evaluated per row). */
    readonly fields: Readonly<Record<string, unknown>>;
    readonly relations: Readonly<Record<string, Relation>>;
    /** Unique keys: single fields and compound ones by Prisma's `a_b` name. */
    readonly unique: readonly (readonly string[])[];
    readonly updatedAt?: boolean;
}

const uuid = () => randomUUID();
const now = () => clock();

let lastTick = 0;

/** A clock that never repeats a millisecond, so `updatedAt` moves on every write
 *  even when the test froze `Date`. */
function clock(): Date {
    lastTick = Math.max(Date.now(), lastTick + 1);
    return new Date(lastTick);
}

const MODELS: Record<string, Model> = {
    user: {
        fields: { id: uuid, name: "", email: "", username: null, isAdmin: false, createdAt: now },
        relations: {},
        unique: [["id"], ["email"]]
    },
    userEmail: {
        fields: {
            id: uuid,
            userId: undefined,
            email: undefined,
            recovery: false,
            verifiedAt: null,
            createdAt: now
        },
        relations: { user: { model: "user", kind: "one", foreignKey: "userId", references: "id" } },
        unique: [["id"], ["email"]]
    },
    team: {
        fields: { id: uuid, name: "", orgName: "" },
        relations: {},
        unique: [["id"]]
    },
    calendarSource: {
        fields: {
            id: uuid,
            userId: undefined,
            kind: undefined,
            label: "",
            connectionId: null,
            url: "",
            username: "",
            encryptedSecret: null,
            secretNonce: null,
            secretKeyId: null,
            refreshMinutes: 15,
            status: "ok",
            lastError: null,
            lastSyncAt: null,
            nextSyncAt: now,
            createdAt: now,
            updatedAt: now
        },
        relations: {
            user: { model: "user", kind: "one", foreignKey: "userId", references: "id" },
            calendars: {
                model: "calendar",
                kind: "many",
                foreignKey: "sourceId",
                references: "id",
                cascade: true
            }
        },
        unique: [["id"]],
        updatedAt: true
    },
    calendar: {
        fields: {
            id: uuid,
            ownerId: undefined,
            sourceId: null,
            kind: "local",
            name: undefined,
            description: "",
            color: "#3b82f6",
            timezone: "",
            components: "VEVENT",
            remoteId: "",
            syncToken: "",
            ctag: "",
            readOnly: false,
            transparent: false,
            alarmsMuted: false,
            defaultAlarms: "",
            resource: "",
            publicToken: null,
            publicMode: "",
            trashedAt: null,
            createdAt: now,
            updatedAt: now
        },
        relations: {
            owner: { model: "user", kind: "one", foreignKey: "ownerId", references: "id" },
            source: {
                model: "calendarSource",
                kind: "one",
                foreignKey: "sourceId",
                references: "id"
            },
            objects: {
                model: "calendarObject",
                kind: "many",
                foreignKey: "calendarId",
                references: "id",
                cascade: true
            },
            shares: {
                model: "calendarShare",
                kind: "many",
                foreignKey: "calendarId",
                references: "id",
                cascade: true
            },
            displays: {
                model: "calendarDisplay",
                kind: "many",
                foreignKey: "calendarId",
                references: "id",
                cascade: true
            }
        },
        unique: [["id"], ["publicToken"]],
        updatedAt: true
    },
    calendarDisplay: {
        fields: {
            id: uuid,
            calendarId: undefined,
            userId: undefined,
            position: 0,
            hidden: false,
            color: null
        },
        relations: {
            calendar: {
                model: "calendar",
                kind: "one",
                foreignKey: "calendarId",
                references: "id"
            },
            user: { model: "user", kind: "one", foreignKey: "userId", references: "id" }
        },
        unique: [["id"], ["calendarId", "userId"]]
    },
    calendarShare: {
        fields: {
            id: uuid,
            calendarId: undefined,
            userId: null,
            teamId: null,
            access: "read",
            createdById: null,
            createdAt: now
        },
        relations: {
            calendar: {
                model: "calendar",
                kind: "one",
                foreignKey: "calendarId",
                references: "id"
            },
            user: { model: "user", kind: "one", foreignKey: "userId", references: "id" },
            team: { model: "team", kind: "one", foreignKey: "teamId", references: "id" }
        },
        unique: [["id"], ["calendarId", "userId"], ["calendarId", "teamId"]]
    },
    calendarObject: {
        fields: {
            id: uuid,
            calendarId: undefined,
            uid: undefined,
            component: "VEVENT",
            ics: undefined,
            href: "",
            etag: "",
            summary: "",
            location: "",
            startsAt: null,
            endsAt: null,
            allDay: false,
            recurring: false,
            status: "",
            pendingPush: "",
            conflictIcs: null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now
        },
        relations: {
            calendar: {
                model: "calendar",
                kind: "one",
                foreignKey: "calendarId",
                references: "id"
            },
            reminders: {
                model: "calendarReminder",
                kind: "many",
                foreignKey: "objectId",
                references: "id",
                cascade: true
            },
            invitations: {
                model: "calendarInvitation",
                kind: "many",
                foreignKey: "objectId",
                references: "id",
                cascade: true
            }
        },
        unique: [["id"], ["calendarId", "uid"]],
        updatedAt: true
    },
    calendarReminder: {
        fields: {
            id: uuid,
            objectId: undefined,
            userId: undefined,
            fireAt: undefined,
            occurrence: undefined,
            alarmKey: undefined,
            action: "DISPLAY"
        },
        relations: {
            object: {
                model: "calendarObject",
                kind: "one",
                foreignKey: "objectId",
                references: "id"
            },
            user: { model: "user", kind: "one", foreignKey: "userId", references: "id" }
        },
        unique: [["id"], ["objectId", "userId", "alarmKey", "occurrence"]]
    },
    calendarInvitation: {
        fields: {
            id: uuid,
            objectId: undefined,
            email: undefined,
            userId: null,
            token: undefined,
            partstat: "NEEDS-ACTION",
            sentAt: null,
            respondedAt: null,
            createdAt: now
        },
        relations: {
            object: {
                model: "calendarObject",
                kind: "one",
                foreignKey: "objectId",
                references: "id"
            }
        },
        unique: [["id"], ["token"], ["objectId", "email"]]
    },
    calendarPreference: {
        fields: { userId: undefined, value: "{}", updatedAt: now },
        relations: { user: { model: "user", kind: "one", foreignKey: "userId", references: "id" } },
        unique: [["userId"]],
        updatedAt: true
    }
};

/** Prisma's name for a compound unique key. */
function keyName(fields: readonly string[]): string {
    return fields.join("_");
}

/** A refusal shaped like Prisma's known request errors. */
export class FakePrismaError extends Error {
    public constructor(
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "PrismaClientKnownRequestError";
    }
}

function unsupported(what: string): never {
    throw new Error(`fake-db: unsupported ${what}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !(value instanceof Date) &&
        !(value instanceof Uint8Array) &&
        !Array.isArray(value)
    );
}

function copyValue(value: unknown): unknown {
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Uint8Array) return new Uint8Array(value);
    return value;
}

function same(left: unknown, right: unknown): boolean {
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
    if (left instanceof Date || right instanceof Date) return false;
    return left === right;
}

function comparable(value: unknown): number | string {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" || typeof value === "string") return value;
    return unsupported(`comparison of ${typeof value}`);
}

const SCALAR_OPERATORS = new Set([
    "equals",
    "in",
    "notIn",
    "not",
    "lt",
    "lte",
    "gt",
    "gte",
    "contains",
    "startsWith",
    "endsWith",
    "mode"
]);

export function createFakeDb() {
    const tables = new Map<string, Row[]>(Object.keys(MODELS).map((name) => [name, []]));

    function modelOf(name: string): Model {
        return MODELS[name] ?? unsupported(`model ${name}`);
    }

    function rowsOf(name: string): Row[] {
        return tables.get(name) ?? unsupported(`model ${name}`);
    }

    function related(model: string, row: Row, relationName: string): Row[] {
        const relation =
            modelOf(model).relations[relationName] ??
            unsupported(`relation ${model}.${relationName}`);
        if (relation.kind === "one") {
            const key = row[relation.foreignKey];
            if (key === null || key === undefined) return [];
            return rowsOf(relation.model).filter((other) => same(other[relation.references], key));
        }
        const key = row[relation.references];
        return rowsOf(relation.model).filter((other) => same(other[relation.foreignKey], key));
    }

    function matchesScalar(value: unknown, filter: unknown): boolean {
        if (filter === undefined) return true;
        if (filter === null) return value === null || value === undefined;
        if (!isPlainObject(filter)) return same(value, filter);
        for (const operator of Object.keys(filter)) {
            if (!SCALAR_OPERATORS.has(operator)) unsupported(`operator ${operator}`);
        }
        const insensitive = filter.mode === "insensitive";
        if (filter.mode !== undefined && filter.mode !== "insensitive" && filter.mode !== "default")
            unsupported(`mode ${String(filter.mode)}`);
        const text = (input: unknown) =>
            insensitive && typeof input === "string" ? input.toLowerCase() : input;
        if ("equals" in filter && !matchesScalar(value, filter.equals)) return false;
        if ("in" in filter) {
            if (!Array.isArray(filter.in)) unsupported("non-array in");
            if (!(filter.in as unknown[]).some((candidate) => same(value, candidate))) return false;
        }
        if ("notIn" in filter) {
            if (!Array.isArray(filter.notIn)) unsupported("non-array notIn");
            if (value === null || value === undefined) return false;
            if ((filter.notIn as unknown[]).some((candidate) => same(value, candidate)))
                return false;
        }
        if ("not" in filter) {
            const negated = filter.not;
            if (negated === null) {
                if (value === null || value === undefined) return false;
            } else if (isPlainObject(negated)) {
                if (value === null || value === undefined || matchesScalar(value, negated))
                    return false;
            } else if (value === null || value === undefined || same(value, negated)) {
                return false;
            }
        }
        for (const [operator, test] of [
            ["lt", (a: number | string, b: number | string) => a < b],
            ["lte", (a: number | string, b: number | string) => a <= b],
            ["gt", (a: number | string, b: number | string) => a > b],
            ["gte", (a: number | string, b: number | string) => a >= b]
        ] as const) {
            if (!(operator in filter)) continue;
            if (value === null || value === undefined) return false;
            if (!test(comparable(value), comparable(filter[operator]))) return false;
        }
        for (const operator of ["contains", "startsWith", "endsWith"] as const) {
            if (!(operator in filter)) continue;
            if (typeof value !== "string" || typeof filter[operator] !== "string") return false;
            const haystack = text(value) as string;
            const needle = text(filter[operator]) as string;
            if (operator === "contains" && !haystack.includes(needle)) return false;
            if (operator === "startsWith" && !haystack.startsWith(needle)) return false;
            if (operator === "endsWith" && !haystack.endsWith(needle)) return false;
        }
        return true;
    }

    function matches(model: string, row: Row, where: unknown): boolean {
        if (where === undefined) return true;
        if (!isPlainObject(where))
            return unsupported(`where on ${model}: ${JSON.stringify(where)}`);
        const definition = modelOf(model);
        for (const [key, filter] of Object.entries(where)) {
            if (filter === undefined) continue;
            if (key === "AND") {
                const all = Array.isArray(filter) ? filter : [filter];
                if (!all.every((part) => matches(model, row, part))) return false;
                continue;
            }
            if (key === "OR") {
                if (!Array.isArray(filter)) unsupported("non-array OR");
                if (!(filter as unknown[]).some((part) => matches(model, row, part))) return false;
                continue;
            }
            if (key === "NOT") {
                const all = Array.isArray(filter) ? filter : [filter];
                if (all.some((part) => matches(model, row, part))) return false;
                continue;
            }
            const compound = definition.unique.find(
                (fields) => fields.length > 1 && keyName(fields) === key
            );
            if (compound) {
                if (!isPlainObject(filter)) unsupported(`compound key ${key}`);
                for (const field of compound) {
                    if (!same(row[field], (filter as Row)[field])) return false;
                }
                continue;
            }
            const relation = definition.relations[key];
            if (relation) {
                if (!matchesRelation(model, row, key, relation, filter)) return false;
                continue;
            }
            if (!(key in definition.fields)) unsupported(`field ${model}.${key} in where`);
            if (!matchesScalar(row[key], filter)) return false;
        }
        return true;
    }

    function matchesRelation(
        model: string,
        row: Row,
        name: string,
        relation: Relation,
        filter: unknown
    ): boolean {
        const others = related(model, row, name);
        if (relation.kind === "one") {
            if (filter === null) return others.length === 0;
            if (!isPlainObject(filter)) return unsupported(`relation filter ${model}.${name}`);
            if ("is" in filter || "isNot" in filter) {
                if ("is" in filter) {
                    if (
                        filter.is === null
                            ? others.length > 0
                            : !others.some((other) => matches(relation.model, other, filter.is))
                    )
                        return false;
                }
                if ("isNot" in filter) {
                    if (
                        filter.isNot === null
                            ? others.length === 0
                            : others.some((other) => matches(relation.model, other, filter.isNot))
                    )
                        return false;
                }
                return true;
            }
            return others.some((other) => matches(relation.model, other, filter));
        }
        if (!isPlainObject(filter)) return unsupported(`relation filter ${model}.${name}`);
        for (const operator of Object.keys(filter)) {
            if (!["some", "every", "none"].includes(operator))
                unsupported(`list relation operator ${operator}`);
        }
        if (
            "some" in filter &&
            !others.some((other) => matches(relation.model, other, filter.some))
        )
            return false;
        if (
            "every" in filter &&
            !others.every((other) => matches(relation.model, other, filter.every))
        )
            return false;
        if ("none" in filter && others.some((other) => matches(relation.model, other, filter.none)))
            return false;
        return true;
    }

    function sortRows(model: string, rows: Row[], orderBy: unknown): Row[] {
        if (orderBy === undefined) return rows;
        const orders = (Array.isArray(orderBy) ? orderBy : [orderBy]) as unknown[];
        const definition = modelOf(model);
        const keys = orders.flatMap((order) => {
            if (!isPlainObject(order)) return unsupported("orderBy form");
            return Object.entries(order).map(([field, direction]) => {
                if (!(field in definition.fields)) unsupported(`orderBy ${model}.${field}`);
                if (direction !== "asc" && direction !== "desc")
                    unsupported(`orderBy direction ${String(direction)}`);
                return { field, direction };
            });
        });
        return [...rows].sort((left, right) => {
            for (const { field, direction } of keys) {
                const a = left[field];
                const b = right[field];
                const aNull = a === null || a === undefined;
                const bNull = b === null || b === undefined;
                // PostgreSQL: nulls sort as larger than every value.
                if (aNull && bNull) continue;
                const order = aNull
                    ? 1
                    : bNull
                      ? -1
                      : comparable(a) < comparable(b)
                        ? -1
                        : comparable(a) > comparable(b)
                          ? 1
                          : 0;
                if (order !== 0) return direction === "asc" ? order : -order;
            }
            return 0;
        });
    }

    function shape(model: string, row: Row, select: unknown, include: unknown): Row {
        const definition = modelOf(model);
        if (select !== undefined && include !== undefined) unsupported("select with include");
        const out: Row = {};
        if (select === undefined) {
            for (const field of Object.keys(definition.fields)) out[field] = copyValue(row[field]);
            if (include === undefined) return out;
            if (!isPlainObject(include)) return unsupported("include form");
            for (const [name, spec] of Object.entries(include)) {
                if (spec) out[name] = relationValue(model, row, name, spec);
            }
            return out;
        }
        if (!isPlainObject(select)) return unsupported("select form");
        for (const [name, spec] of Object.entries(select)) {
            if (!spec) continue;
            if (name === "_count") {
                if (!isPlainObject(spec) || !isPlainObject(spec.select)) unsupported("_count form");
                const counts: Row = {};
                for (const [relationName, relationSpec] of Object.entries(
                    (spec as { select: Row }).select
                )) {
                    if (!relationSpec) continue;
                    const relation =
                        definition.relations[relationName] ??
                        unsupported(`_count of ${model}.${relationName}`);
                    const where = isPlainObject(relationSpec) ? relationSpec.where : undefined;
                    counts[relationName] = related(model, row, relationName).filter((other) =>
                        matches(relation.model, other, where)
                    ).length;
                }
                out._count = counts;
                continue;
            }
            if (name in definition.relations) {
                out[name] = relationValue(model, row, name, spec);
                continue;
            }
            if (!(name in definition.fields)) unsupported(`select ${model}.${name}`);
            if (spec !== true) unsupported(`select ${model}.${name} form`);
            out[name] = copyValue(row[name]);
        }
        return out;
    }

    function relationValue(model: string, row: Row, name: string, spec: unknown): unknown {
        const relation = modelOf(model).relations[name]!;
        const options = isPlainObject(spec) ? spec : {};
        for (const key of Object.keys(options)) {
            if (!["select", "include", "where", "orderBy", "take"].includes(key))
                unsupported(`nested ${key}`);
        }
        let others = related(model, row, name).filter((other) =>
            matches(relation.model, other, options.where)
        );
        if (relation.kind === "one") {
            const [first] = others;
            return first ? shape(relation.model, first, options.select, options.include) : null;
        }
        others = sortRows(relation.model, others, options.orderBy);
        if (typeof options.take === "number") others = others.slice(0, options.take);
        return others.map((other) => shape(relation.model, other, options.select, options.include));
    }

    function checkData(model: string, data: unknown): Row {
        if (!isPlainObject(data)) return unsupported(`data on ${model}`);
        const definition = modelOf(model);
        for (const [field, value] of Object.entries(data)) {
            if (!(field in definition.fields)) unsupported(`field ${model}.${field} in data`);
            if (isPlainObject(value) && !("increment" in value) && !("set" in value))
                unsupported(`nested write ${model}.${field}`);
        }
        return data;
    }

    function violatesUnique(model: string, candidate: Row, except: Row | null): string | null {
        for (const fields of modelOf(model).unique) {
            // PostgreSQL treats nulls as distinct in a unique index.
            if (fields.some((field) => candidate[field] === null || candidate[field] === undefined))
                continue;
            const clash = rowsOf(model).find(
                (row) =>
                    row !== except && fields.every((field) => same(row[field], candidate[field]))
            );
            if (clash) return keyName(fields);
        }
        return null;
    }

    function build(model: string, data: unknown): Row {
        const given = checkData(model, data);
        const definition = modelOf(model);
        const row: Row = {};
        for (const [field, fallback] of Object.entries(definition.fields)) {
            const value = given[field];
            if (value !== undefined) row[field] = copyValue(value);
            else if (typeof fallback === "function") row[field] = (fallback as () => unknown)();
            else if (fallback === undefined)
                throw new FakePrismaError("P2012", `fake-db: ${model}.${field} is required`);
            else row[field] = fallback;
        }
        const clash = violatesUnique(model, row, null);
        if (clash) throw new FakePrismaError("P2002", `fake-db: unique ${model}.${clash} violated`);
        return row;
    }

    function apply(model: string, row: Row, data: unknown): void {
        const given = checkData(model, data);
        const next: Row = { ...row };
        for (const [field, value] of Object.entries(given)) {
            if (value === undefined) continue;
            if (isPlainObject(value)) {
                if ("set" in value) next[field] = copyValue(value.set);
                else next[field] = (next[field] as number) + (value.increment as number);
                continue;
            }
            next[field] = copyValue(value);
        }
        if (modelOf(model).updatedAt && !("updatedAt" in given)) next.updatedAt = clock();
        const clash = violatesUnique(model, next, row);
        if (clash) throw new FakePrismaError("P2002", `fake-db: unique ${model}.${clash} violated`);
        Object.assign(row, next);
    }

    function remove(model: string, row: Row): void {
        const definition = modelOf(model);
        for (const [name, relation] of Object.entries(definition.relations)) {
            if (relation.kind !== "many" || !relation.cascade) continue;
            for (const other of related(model, row, name)) remove(relation.model, other);
        }
        const rows = rowsOf(model);
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
    }

    function findUniqueRow(model: string, where: unknown): Row | null {
        if (!isPlainObject(where)) return unsupported(`unique where on ${model}`);
        const definition = modelOf(model);
        const named = Object.keys(where).filter((key) => where[key] !== undefined);
        const isUnique = definition.unique.some((fields) =>
            fields.length === 1 ? named.includes(fields[0]!) : named.includes(keyName(fields))
        );
        if (!isUnique)
            unsupported(`findUnique on ${model} without a unique key: ${named.join(",")}`);
        return rowsOf(model).find((row) => matches(model, row, where)) ?? null;
    }

    type Args = Record<string, unknown>;

    function delegate(model: string) {
        const findMany = (args: Args = {}): Row[] => {
            for (const key of Object.keys(args)) {
                if (!["where", "select", "include", "orderBy", "take", "skip"].includes(key))
                    unsupported(`findMany ${key}`);
            }
            let rows = rowsOf(model).filter((row) => matches(model, row, args.where));
            rows = sortRows(model, rows, args.orderBy);
            if (typeof args.skip === "number") rows = rows.slice(args.skip);
            if (typeof args.take === "number") rows = rows.slice(0, args.take);
            return rows.map((row) => shape(model, row, args.select, args.include));
        };
        const notFound = () => new FakePrismaError("P2025", `fake-db: no ${model} found`);
        return {
            findMany: async (args?: Args) => findMany(args),
            findFirst: async (args: Args = {}) => findMany({ ...args, take: 1 })[0] ?? null,
            findFirstOrThrow: async (args: Args = {}) => {
                const found = findMany({ ...args, take: 1 })[0];
                if (!found) throw notFound();
                return found;
            },
            findUnique: async (args: Args) => {
                const row = findUniqueRow(model, args.where);
                return row ? shape(model, row, args.select, args.include) : null;
            },
            findUniqueOrThrow: async (args: Args) => {
                const row = findUniqueRow(model, args.where);
                if (!row) throw notFound();
                return shape(model, row, args.select, args.include);
            },
            count: async (args: Args = {}) =>
                rowsOf(model).filter((row) => matches(model, row, args.where)).length,
            create: async (args: Args) => {
                const row = build(model, args.data);
                rowsOf(model).push(row);
                return shape(model, row, args.select, args.include);
            },
            createMany: async (args: Args) => {
                const list = (Array.isArray(args.data) ? args.data : [args.data]) as unknown[];
                let count = 0;
                for (const data of list) {
                    try {
                        rowsOf(model).push(build(model, data));
                        count += 1;
                    } catch (caught) {
                        if (
                            args.skipDuplicates &&
                            caught instanceof FakePrismaError &&
                            caught.code === "P2002"
                        )
                            continue;
                        throw caught;
                    }
                }
                return { count };
            },
            update: async (args: Args) => {
                const row = findUniqueRow(model, args.where);
                if (!row) throw notFound();
                apply(model, row, args.data);
                return shape(model, row, args.select, args.include);
            },
            updateMany: async (args: Args) => {
                const rows = rowsOf(model).filter((row) => matches(model, row, args.where));
                for (const row of rows) apply(model, row, args.data);
                return { count: rows.length };
            },
            upsert: async (args: Args) => {
                const row = findUniqueRow(model, args.where);
                if (row) {
                    apply(model, row, args.update);
                    return shape(model, row, args.select, args.include);
                }
                const created = build(model, args.create);
                rowsOf(model).push(created);
                return shape(model, created, args.select, args.include);
            },
            delete: async (args: Args) => {
                const row = findUniqueRow(model, args.where);
                if (!row) throw notFound();
                const shaped = shape(model, row, args.select, args.include);
                remove(model, row);
                return shaped;
            },
            deleteMany: async (args: Args = {}) => {
                const rows = rowsOf(model).filter((row) => matches(model, row, args.where));
                for (const row of rows) remove(model, row);
                return { count: rows.length };
            }
        };
    }

    const prisma = {
        user: delegate("user"),
        userEmail: delegate("userEmail"),
        team: delegate("team"),
        calendarSource: delegate("calendarSource"),
        calendar: delegate("calendar"),
        calendarDisplay: delegate("calendarDisplay"),
        calendarShare: delegate("calendarShare"),
        calendarObject: delegate("calendarObject"),
        calendarReminder: delegate("calendarReminder"),
        calendarInvitation: delegate("calendarInvitation"),
        calendarPreference: delegate("calendarPreference"),
        $transaction: async (work: unknown): Promise<unknown> => {
            if (Array.isArray(work)) {
                const results: unknown[] = [];
                for (const step of work) results.push(await step);
                return results;
            }
            if (typeof work === "function")
                return (work as (client: unknown) => Promise<unknown>)(prisma);
            return unsupported("$transaction form");
        }
    };

    return {
        prisma,
        /** The rows of one model, live - for seeding and asserting. */
        rows: (model: string): Row[] => rowsOf(model),
        /** Insert a row with the model's defaults applied. */
        insert: (model: string, data: Row): Row => {
            const row = build(model, data);
            rowsOf(model).push(row);
            return row;
        },
        /** One row by id, live. */
        byId: (model: string, id: string): Row | undefined =>
            rowsOf(model).find((row) => row.id === id),
        reset: () => {
            for (const rows of tables.values()) rows.length = 0;
        }
    };
}

export type FakeDb = ReturnType<typeof createFakeDb>;

/** The one database every Calendar server test shares; reset before each test. */
export const db = createFakeDb();

/** What `vi.mock("@polaris/db", ...)` answers with. */
export const dbModule = { prisma: db.prisma, VISIBLE_USER: {} };
