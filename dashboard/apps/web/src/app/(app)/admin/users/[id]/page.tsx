/**
 * One person's overview: who they are, then the switches that decide their
 * reach - role, administrator access, and opening the account as them.
 *
 * The record used to be one page holding every control and every resolution at
 * once. Each concern now has its own section route under this one (see
 * `section-nav`), so this page reads only the identity and the role list.
 */

import { requireAdmin } from "@/lib/session";
import { loadUserRecord } from "./user-record";
import { IdentityCard } from "./identity-card";
import { listRoleOptions } from "@/lib/role-service";
import { OverviewControls } from "./overview-controls";

export const dynamic = "force-dynamic";

export default async function UserOverviewPage({ params }: { params: Promise<{ id: string }> }) {
    const admin = await requireAdmin();
    const { id } = await params;
    const [account, roles] = await Promise.all([loadUserRecord(id), listRoleOptions()]);

    return (
        <div className="flex flex-col gap-4">
            {/* Who they are, before anything about what they may do. */}
            <IdentityCard userId={account.id} />
            <OverviewControls user={account} roles={roles} isSelf={account.id === admin.id} />
        </div>
    );
}
