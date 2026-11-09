/**
 * @polaris/db - the single Prisma client and the re-exported generated types.
 *
 * A process-wide singleton avoids exhausting the connection pool during Next.js
 * hot reloads, which otherwise construct a fresh client on every module reload.
 * In production a single client is constructed once. All other packages import
 * the client and the model types from here so there is exactly one schema of
 * record.
 */

import { PrismaClient } from "../generated/client/index.js";

/**
 * How many connections one Polaris process may hold open.
 *
 * Prisma's own default is `cores * 2 + 1`, which on the kind of box Polaris runs
 * on is around sixty - and it holds them, idle, for the life of the process.
 * Postgres ships with room for a hundred clients, so a single dashboard was
 * sitting on well over half of them and an update was enough to run out: the
 * container being replaced still holds its sixty while the new one opens sixty
 * of its own, Postgres refuses the rest, and the screen somebody was looking at
 * fails to render with a reference number and no explanation. That is exactly
 * what a reader saw, twice, seconds after pressing Update.
 *
 * Fifteen is more than a request ever needs - the widest page here runs a
 * handful of queries at once - and it leaves the headroom two overlapping
 * versions of Polaris need to hand over cleanly.
 */
const CONNECTION_LIMIT = 15;

/**
 * The database URL with a ceiling on it, unless one was set deliberately.
 *
 * Applied here rather than asked of the operator, because an installed Polaris
 * is never edited by hand: a fix that only works once somebody adds a query
 * parameter to a file inside a container is a fix nobody has.
 */
function boundedUrl(): string | null {
    const raw = process.env.POLARIS_DATABASE_URL;
    if (!raw) return null;
    try {
        const url = new URL(raw);
        // A pooler in front of the database, or an operator who has chosen a
        // number, both know better than this does.
        if (url.searchParams.has("connection_limit")) return null;
        url.searchParams.set("connection_limit", String(CONNECTION_LIMIT));
        return url.toString();
    } catch {
        // Not a URL this can parse - a socket path, something unusual. Left
        // exactly as it was rather than guessed at.
        return null;
    }
}

const globalForPrisma = globalThis as unknown as { polarisPrisma?: PrismaClient };

/** The models a delete moves to the recycle bin instead of removing. */
const BINNABLE = new Set(["Application", "Project", "ManagedDatabase"]);
const READS = new Set([
    "findMany",
    "findFirst",
    "findFirstOrThrow",
    "findUnique",
    "findUniqueOrThrow",
    "count",
    "aggregate",
    "groupBy"
]);

/**
 * Spread into a `where` to read rows whether or not they are in the recycle bin.
 * Only the bin itself, a restore and a purge want this.
 */
export const INCLUDING_BINNED = { binnedAt: undefined } as const;

/** Spread into a nested relation read so binned rows stay out of it too. */
export const NOT_BINNED = { binnedAt: null } as const;

/**
 * Every top-level read of a binnable model leaves binned rows out, unless the
 * `where` already says something about `binnedAt`. One rule in one place rather
 * than a filter at each of the two hundred call sites, so a list, a reconciler
 * or a poller written tomorrow cannot bring a deleted service back by forgetting
 * it. Nested relation reads are not reached by a query extension and carry
 * `NOT_BINNED` themselves.
 */
export function hidingBinned(base: PrismaClient): PrismaClient {
    return base.$extends({
        query: {
            $allModels: {
                async $allOperations({ model, operation, args, query }) {
                    if (!BINNABLE.has(model) || !READS.has(operation)) return query(args);
                    const shaped = (args ?? {}) as { where?: Record<string, unknown> };
                    if (shaped.where && "binnedAt" in shaped.where) return query(args);
                    return query({
                        ...shaped,
                        where: { ...shaped.where, binnedAt: null }
                    } as typeof args);
                }
            }
        }
    }) as unknown as PrismaClient;
}

/**
 * The tables what somebody may reach is worked out from: roles, groups,
 * policies, direct permissions, grants, organisations and their teams, and the
 * apps installed. A write to any of them can add an app to somebody's switcher
 * or take one away.
 */
const ACCESS_MODELS = new Set([
    "Role",
    "UserRole",
    "Group",
    "GroupMember",
    "AccessGroup",
    "UserAccessGroup",
    "Policy",
    "PolicyAttachment",
    "UserPermission",
    "AccessGrant",
    "ResourceGrant",
    "InstalledApp",
    "Organization",
    "OrganizationMember",
    "OrgRole",
    "Team",
    "TeamMember",
    "VpnAccess",
    "PolarToolGrant"
]);
/** The columns of an account that change what it may reach. Any other write to
 *  a user - a name, a last-seen time - is not an access change. */
const USER_ACCESS_FIELDS = ["isAdmin", "role", "bannedAt", "disabledAt"];
const WRITES = new Set([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "upsert",
    "delete",
    "deleteMany"
]);

/** Whose access a write moved: the accounts it names, or none for "anybody's". */
export interface AccessWrite {
    readonly model: string;
    readonly userIds: readonly string[];
}

type AccessWriteListener = (write: AccessWrite) => void;
const ACCESS_WRITES = Symbol.for("polaris.db.access-writes");

function accessWriteListeners(): Set<AccessWriteListener> {
    const holder = globalThis as { [ACCESS_WRITES]?: Set<AccessWriteListener> };
    holder[ACCESS_WRITES] ??= new Set();
    return holder[ACCESS_WRITES];
}

/**
 * Hear about every write that may have changed what somebody reaches, whichever
 * screen, job or service made it. The live access channel listens here, so a
 * permission granted by any path - an administrator's screen, an organisation
 * role, an accepted invitation, an app installed - reaches the person's open
 * tabs without each of those paths having to remember to say so.
 */
export function onAccessWrite(listener: AccessWriteListener): () => void {
    const listeners = accessWriteListeners();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The one account a write is about, when its `where` or its data names one. */
function namedUser(model: string, args: unknown): string[] {
    const shaped = (args ?? {}) as {
        where?: Record<string, unknown>;
        data?: unknown;
        create?: Record<string, unknown>;
    };
    const candidates = [
        shaped.where?.userId,
        model === "User" ? shaped.where?.id : undefined,
        Array.isArray(shaped.data) ? undefined : (shaped.data as Record<string, unknown> | undefined)?.userId,
        shaped.create?.userId
    ];
    const found = candidates.find((value): value is string => typeof value === "string");
    return found ? [found] : [];
}

function touchesUserAccess(args: unknown): boolean {
    const shaped = (args ?? {}) as { data?: unknown; update?: unknown };
    const data = [shaped.data, shaped.update].filter(
        (value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
    );
    return data.some((one) => USER_ACCESS_FIELDS.some((field) => field in one));
}

/** What a query means for access: null when it cannot change what anybody reaches. */
export function accessWriteOf(model: string, operation: string, args: unknown): AccessWrite | null {
    if (!WRITES.has(operation)) return null;
    if (!ACCESS_MODELS.has(model) && !(model === "User" && touchesUserAccess(args))) return null;
    return { model, userIds: namedUser(model, args) };
}

/** Tell the listeners after a write lands. A listener that throws is one dead
 *  connection and never the write's failure. */
export function announcingAccessWrites(base: PrismaClient): PrismaClient {
    return base.$extends({
        query: {
            $allModels: {
                async $allOperations({ model, operation, args, query }) {
                    const result = await query(args);
                    const listeners = accessWriteListeners();
                    if (listeners.size === 0) return result;
                    const write = accessWriteOf(model, operation, args);
                    if (!write) return result;
                    for (const listener of listeners) {
                        try {
                            listener(write);
                        } catch (caught) {
                            console.error(caught);
                        }
                    }
                    return result;
                }
            }
        }
    }) as unknown as PrismaClient;
}

function client(): PrismaClient {
    const url = boundedUrl();
    return announcingAccessWrites(
        hidingBinned(url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient())
    );
}

export const prisma: PrismaClient = globalForPrisma.polarisPrisma ?? client();

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.polarisPrisma = prisma;
}

export * from "../generated/client/index.js";

/**
 * The accounts that exist as far as everybody else is concerned.
 *
 * Two ways an account stops being one, and every screen that lists, searches,
 * mentions or opens a person has to hide both: the instance suspended it, or its
 * owner switched it off. They were one condition spelled out in eight places,
 * which is eight places to forget the second one - and forgetting it is a
 * disabled account still turning up in a search, which is precisely what
 * disabling is for.
 *
 * Deliberately not applied on the sign-in path. A disabled account signing in is
 * how it comes back, so the challenge that resolves it must still find it.
 */
export const VISIBLE_USER = { bannedAt: null, disabledAt: null } as const;
