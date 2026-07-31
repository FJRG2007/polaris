import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { listInvites } from "@/lib/invite-service";
import { listImposableGroups, listUserDirectory } from "@/lib/user-admin-service";
import { UsersAdmin } from "./users-admin";

export const dynamic = "force-dynamic";

export default async function UsersAdminPage() {
    const admin = await requireAdmin();
    const [users, invites, groups, mail] = await Promise.all([
        listUserDirectory(),
        listInvites(),
        listImposableGroups(admin.id),
        getAuthMailStatus()
    ]);

    return (
        <>
            <PageHeader
                title="People"
                description="Registration is invite-only. Invite people, and manage what their accounts may do."
            />
            <UsersAdmin
                users={users}
                invites={invites}
                groups={groups.map((group) => ({ id: group.id, name: group.name }))}
                canSendMail={mail.ready}
                viewerId={admin.id}
            />
        </>
    );
}
