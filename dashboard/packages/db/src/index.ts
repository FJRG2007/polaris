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

function client(): PrismaClient {
    const url = boundedUrl();
    return url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
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
