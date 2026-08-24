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

const globalForPrisma = globalThis as unknown as { polarisPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.polarisPrisma ?? new PrismaClient();

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
