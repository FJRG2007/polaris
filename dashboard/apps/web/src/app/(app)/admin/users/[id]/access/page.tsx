/**
 * What this person can do, and why: groups, policies, capabilities and the
 * things they were given access to.
 *
 * The only section that needs the group and policy catalogues, so they are read
 * here and nowhere else. The resolution itself loads after the paint.
 */

import { requireAdmin } from "@/lib/session";
import { UserAccessRegion } from "../loaders";

export const dynamic = "force-dynamic";

export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin();
    const { id } = await params;
    return <UserAccessRegion userId={id} revision={Date.now()} />;
}
