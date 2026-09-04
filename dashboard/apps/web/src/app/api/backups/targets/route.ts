/**
 * What a new destination could be built on: the storage connections and the
 * servers this account already has.
 *
 * Names and ids only. The dialog needs to offer a choice, not to know anything
 * about how either is reached. Admin-only. Node runtime for Prisma.
 */

import { prisma } from "@polaris/db";
import { apiAdmin } from "@/lib/api-session";
import { PERSONAL_KIND } from "@polaris/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    const [connections, hosts] = await Promise.all([
        prisma.storageConnection.findMany({
            // Never somebody's own drive: a backup is the instance's, and a
            // person's drive is not a disk it may fill.
            where: { ownerId: user.id, status: "active", kind: { not: PERSONAL_KIND } },
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
