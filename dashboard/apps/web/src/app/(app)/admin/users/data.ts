"use server";

/**
 * What the people directory shows, asked for by the browser after the page has
 * painted (see `UsersAdminLoader`).
 */

import { requireAdmin } from "@/lib/session";
import { listInvites } from "@/lib/invite-service";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { sharingPolicy } from "@/lib/sharing-policy";
import { listRoleOptions } from "@/lib/role-service";
import { getSetting } from "@/lib/setting-store";
import { discoveryPolicy } from "@/lib/people-search";
import { profilesArePublic } from "@/lib/profile-service";
import { defaultFollowerAudience } from "@/lib/privacy-service";
import { usernameCooldownDays, USERNAME_COOLDOWN_KEY } from "@polaris/core";
import { listRecoveryRequests } from "@/lib/account-recovery-service";
import { listImposableGroups, listUserDirectoryPage } from "@/lib/user-admin-service";

export async function loadUsersAdminAction() {
    const admin = await requireAdmin();
    const [
        users,
        invites,
        recoveries,
        groups,
        mail,
        roles,
        sharing,
        cooldown,
        publicProfiles,
        followerDefault,
        discovery
    ] = await Promise.all([
        listUserDirectoryPage(),
        listInvites(),
        listRecoveryRequests(),
        listImposableGroups(admin.id),
        getAuthMailStatus(),
        // Roles are rows an operator adds to under Management > Roles, so the
        // pickers offer whatever this instance actually defines.
        listRoleOptions(),
        sharingPolicy(),
        getSetting(USERNAME_COOLDOWN_KEY),
        profilesArePublic(),
        defaultFollowerAudience(),
        discoveryPolicy()
    ]);
    return {
        users,
        invites,
        recoveries,
        groups: groups.map((group) => ({ id: group.id, name: group.name })),
        roles,
        canSendMail: mail.ready,
        viewerId: admin.id,
        sharing,
        cooldownDays: usernameCooldownDays(cooldown),
        publicProfiles,
        followerDefault,
        discovery
    };
}
