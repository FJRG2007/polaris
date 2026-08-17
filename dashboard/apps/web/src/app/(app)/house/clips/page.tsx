/**
 * The footage the house kept, and what to hold on to.
 */

import { PageHeader } from "@polaris/ui";
import { ClipsView } from "./clips-view";
import { requireHomeUser } from "@/lib/home/access";

export const dynamic = "force-dynamic";

export default async function ClipsPage() {
    const { canManage } = await requireHomeUser("home.read");

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <PageHeader
                title="Clips"
                description="Recordings, newest first. Anything you keep survives the retention window."
            />
            <ClipsView canManage={canManage} />
        </div>
    );
}
