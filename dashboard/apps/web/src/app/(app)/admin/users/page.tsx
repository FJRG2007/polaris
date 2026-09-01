import { PageHeader } from "@polaris/ui";
import { UsersAdmin } from "./users-admin";
import { requireAdmin } from "@/lib/session";
import { listInvites } from "@/lib/invite-service";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { sharingPolicy } from "@/lib/sharing-policy";
import { listRoleOptions } from "@/lib/role-service";
import { getSetting } from "@/lib/setting-store";
import { SharingPolicyForm } from "./sharing-policy-form";
import { UsernameCooldownForm } from "./username-cooldown-form";
import { PublicProfilesForm } from "./public-profiles-form";
import { profilesArePublic } from "@/lib/profile-service";
import { usernameCooldownDays, USERNAME_COOLDOWN_KEY } from "@polaris/core";
import { listRecoveryRequests } from "@/lib/account-recovery-service";
import { listImposableGroups, listUserDirectory } from "@/lib/user-admin-service";

export const dynamic = "force-dynamic";

/** `?user=<id>` opens that account's dialog on arrival, so a screen that names
 *  somebody - the firewall, naming who is signed in from an address it is about
 *  to ban - can hand the reader the account itself rather than its name. */
export default async function UsersAdminPage({
    searchParams
}: {
    searchParams: Promise<{ user?: string }>;
}) {
    const { user } = await searchParams;
    const admin = await requireAdmin();
    const [users, invites, recoveries, groups, mail, roles, sharing, cooldown, publicProfiles] =
        await Promise.all([
        listUserDirectory(),
        listInvites(),
        listRecoveryRequests(),
        listImposableGroups(admin.id),
        getAuthMailStatus(),
        // Roles are rows an operator adds to under Management > Roles, so the
        // pickers offer whatever this instance actually defines.
        listRoleOptions(),
        sharingPolicy(),
        getSetting(USERNAME_COOLDOWN_KEY),
        profilesArePublic()
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
                roles={roles}
                canSendMail={mail.ready}
                viewerId={admin.id}
                openUserId={user ?? null}
            />
            <SharingPolicyForm
                policy={sharing}
                roles={roles.map((role) => ({ value: role.name, label: role.name }))}
            />
            <UsernameCooldownForm days={usernameCooldownDays(cooldown)} />
            <PublicProfilesForm enabled={publicProfiles} />
        </>
    );
}
