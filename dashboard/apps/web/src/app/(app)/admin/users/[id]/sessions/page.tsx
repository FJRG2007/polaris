/** Every device signed in as this person. The list itself loads after the paint. */

import { requireAdmin } from "@/lib/session";
import { loadUserRecord } from "../user-record";
import { SessionsSection } from "../sessions-section";

export const dynamic = "force-dynamic";

export default async function UserSessionsPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin();
    const { id } = await params;
    return <SessionsSection user={await loadUserRecord(id)} />;
}
