/**
 * What a new destination could be built on: the storage connections and the
 * servers this account already has.
 *
 * Names and ids only. The dialog needs to offer a choice, not to know anything
 * about how either is reached. Admin-only. Node runtime for Prisma.
 */

import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await requireAdmin();
    const [connections, hosts] = await Promise.all([
        prisma.storageConnection.findMany({
            where: { ownerId: user.id, status: "active" },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        }),
        prisma.host.findMany({
            where: { ownerId: user.id },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        })
    ]);
    return Response.json({ connections, hosts });
}
