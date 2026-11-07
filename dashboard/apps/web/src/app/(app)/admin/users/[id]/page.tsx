/**
 * One person's overview: who they are, then the switches that decide their
 * reach - role, administrator access, and opening the account as them.
 *
 * The record used to be one page holding every control and every resolution at
 * once. Each concern now has its own section route under this one (see
 * `section-nav`), so this page reads only the identity and the role list.
 */

import { Suspense } from "react";
import { requireAdmin } from "@/lib/session";
import { IdentityCard } from "./identity-card";
import { UserOverviewRegion } from "./loaders";
import { CardSkeleton } from "@/app/(app)/admin/region-skeletons";

export const dynamic = "force-dynamic";

export default async function UserOverviewPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin();
    const { id } = await params;

    return (
        <div className="flex flex-col gap-4">
            {/* Who they are, before anything about what they may do. Streamed, so
                the record paints before its sign-in methods are read. */}
            <Suspense fallback={<CardSkeleton lines={3} />}>
                <IdentityCard userId={id} />
            </Suspense>
            <UserOverviewRegion userId={id} revision={Date.now()} />
        </div>
    );
}
