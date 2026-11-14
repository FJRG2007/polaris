"use client";

import { UsersAdmin } from "./users-admin";
import { loadUsersAdminAction } from "./data";
import { AfterPaint } from "@/components/after-paint";
import { SharingPolicyForm } from "./sharing-policy-form";
import { UsernameCooldownForm } from "./username-cooldown-form";
import { CardSkeleton, TableSkeleton } from "../region-skeletons";

/**
 * The directory and the policies under it. Not kept in the tab: invites and
 * recovery requests are account-access data, and invites carry dates.
 */
export function UsersAdminLoader({
    openUserId,
    revision
}: {
    openUserId: string | null;
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey="admin-users"
            load={loadUsersAdminAction}
            persist={false}
            revision={revision}
            skeleton={
                <>
                    <TableSkeleton rows={10} />
                    <CardSkeleton lines={2} />
                </>
            }
        >
            {(data) => (
                <>
                    <UsersAdmin
                        first={data.users}
                        invites={data.invites}
                        recoveries={data.recoveries}
                        groups={data.groups}
                        roles={data.roles}
                        canSendMail={data.canSendMail}
                        viewerId={data.viewerId}
                        openUserId={openUserId}
                    />
                    <SharingPolicyForm
                        policy={data.sharing}
                        roles={data.roles.map((role) => ({ value: role.name, label: role.name }))}
                    />
                    <UsernameCooldownForm days={data.cooldownDays} />
                </>
            )}
        </AfterPaint>
    );
}
