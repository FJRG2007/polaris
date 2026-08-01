import { PageHeader } from "@polaris/ui";
import { UsersAdmin } from "./users-admin";
import { requireAdmin } from "@/lib/session";
import { listInvites } from "@/lib/invite-service";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { listRecoveryRequests } from "@/lib/account-recovery-service";
import { listImposableGroups, listUserDirectory } from "@/lib/user-admin-service";

export const dynamic = "force-dynamic";

export default async function UsersAdminPage() {
    const admin = await requireAdmin();
    const [users, invites, recoveries, groups, mail] = await Promise.all([
        listUserDirectory(),
        listInvites(),
        listRecoveryRequests(),
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
                recoveries={recoveries}
                groups={groups.map((group) => ({ id: group.id, name: group.name }))}
                canSendMail={mail.ready}
                viewerId={admin.id}
            />
        </>
    );
}
