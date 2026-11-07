/**
 * Getting somebody back into their account and where they may sign in from:
 * the password recovery actions, the sign-in address, and the sign-in limits.
 *
 * The limits editor is the only part that needs the group catalogue, so it is
 * read here and nowhere else.
 */

import { requireAdmin } from "@/lib/session";
import { UserSecurityRegion } from "../loaders";

export const dynamic = "force-dynamic";

export default async function UserSecurityPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin();
    const { id } = await params;
    return <UserSecurityRegion userId={id} revision={Date.now()} />;
}
