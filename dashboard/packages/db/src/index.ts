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
