/**
 * One mail server (/apps/mail-server/<id>): setup as it runs, its health, and
 * everything on it. The server row is resolved here only for the permission;
 * every panel loads its own data after the first paint.
 */

import { z } from "zod";
import { notFound } from "next/navigation";
import { ServerView } from "./server-view";
import { requirePermission } from "@/lib/session";
import { requireServer } from "@/lib/mail-server/access";

export const dynamic = "force-dynamic";

export default async function MailServerDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const user = await requirePermission("mailserver.manage");
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) notFound();
    const server = await requireServer({ id: user.id, isAdmin: user.isAdmin }, id).catch(() => null);
    if (!server) notFound();
    return <ServerView serverId={server.id} hostname={server.hostname} />;
}
