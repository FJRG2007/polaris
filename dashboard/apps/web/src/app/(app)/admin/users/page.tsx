import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { listInvites } from "@/lib/invite-service";
import { UsersAdmin } from "./users-admin";

export const dynamic = "force-dynamic";

export default async function UsersAdminPage() {
    await requireAdmin();
    const [users, invites] = await Promise.all([
        prisma.user.findMany({
            select: { id: true, name: true, email: true, isAdmin: true, createdAt: true },
            orderBy: { createdAt: "asc" }
        }),
        listInvites()
    ]);

    return (
        <>
            <PageHeader
                title="Users"
                description="Registration is invite-only. Invite people and manage access."
            />
            <UsersAdmin
                users={users.map((user) => ({
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    isAdmin: user.isAdmin
                }))}
                invites={invites.map((invite) => ({
                    id: invite.id,
                    email: invite.email,
                    expiresAt: invite.expiresAt.toISOString()
                }))}
            />
        </>
    );
}
