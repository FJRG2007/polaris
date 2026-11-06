/**
 * Getting somebody back into their account and where they may sign in from:
 * the password recovery actions, the sign-in address, and the sign-in limits.
 *
 * The limits editor is the only part that needs the group catalogue, so it is
 * read here and nowhere else.
 */

import { requireAdmin } from "@/lib/session";
import { loadUserRecord } from "../user-record";
import { LimitsSection } from "../limits-section";
import { CredentialsSection } from "../credentials-section";
import { listImposableGroups } from "@/lib/user-admin-service";

export const dynamic = "force-dynamic";

export default async function UserSecurityPage({ params }: { params: Promise<{ id: string }> }) {
    const admin = await requireAdmin();
    const { id } = await params;
    const [account, groups] = await Promise.all([loadUserRecord(id), listImposableGroups(admin.id)]);

    return (
        <div className="flex flex-col gap-4">
            <CredentialsSection user={account} isSelf={account.id === admin.id} />
            <LimitsSection user={account} groups={groups.map((group) => ({ id: group.id, name: group.name }))} />
        </div>
    );
}
