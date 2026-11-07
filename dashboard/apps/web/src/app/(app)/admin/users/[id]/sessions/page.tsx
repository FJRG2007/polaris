/** Every device signed in as this person. The list itself loads after the paint. */

import { requireAdmin } from "@/lib/session";
import { UserSessionsRegion } from "../loaders";

export const dynamic = "force-dynamic";

export default async function UserSessionsPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin();
    const { id } = await params;
    return <UserSessionsRegion userId={id} revision={Date.now()} />;
}
