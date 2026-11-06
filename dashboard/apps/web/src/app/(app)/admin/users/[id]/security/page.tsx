/**
 * Where this person may sign in from.
 *
 * The limits editor is the only part that needs the group catalogue, so it is
 * read here and nowhere else.
 */

import { requireAdmin } from "@/lib/session";
import { loadUserRecord } from "../user-record";
import { LimitsSection } from "../limits-section";
import { listImposableGroups } from "@/lib/user-admin-service";

export const dynamic = "force-dynamic";

export default async function UserSecurityPage({ params }: { params: Promise<{ id: string }> }) {
    const admin = await requireAdmin();
    const { id } = await params;
    const [account, groups] = await Promise.all([loadUserRecord(id), listImposableGroups(admin.id)]);

    return (
        <div className="flex flex-col gap-4">
            <LimitsSection user={account} groups={groups.map((group) => ({ id: group.id, name: group.name }))} />
        </div>
    );
}
