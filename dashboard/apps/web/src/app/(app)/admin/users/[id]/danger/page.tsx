/** Suspending, banning and deleting one account, on a page of their own. */

import { requireAdmin } from "@/lib/session";
import { UserDangerRegion } from "../loaders";

export const dynamic = "force-dynamic";

export default async function UserDangerPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin();
    const { id } = await params;
    return <UserDangerRegion userId={id} revision={Date.now()} />;
}
