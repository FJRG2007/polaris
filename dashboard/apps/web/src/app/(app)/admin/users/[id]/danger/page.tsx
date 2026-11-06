/** Suspending, banning and deleting one account, on a page of their own. */

import { requireAdmin } from "@/lib/session";
import { loadUserRecord } from "../user-record";
import { DangerSection } from "../danger-section";

export const dynamic = "force-dynamic";

export default async function UserDangerPage({ params }: { params: Promise<{ id: string }> }) {
    const admin = await requireAdmin();
    const { id } = await params;
    const account = await loadUserRecord(id);
    return <DangerSection user={account} isSelf={account.id === admin.id} />;
}
