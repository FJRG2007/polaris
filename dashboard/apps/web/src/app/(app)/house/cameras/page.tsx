/**
 * The cameras themselves: adding them, changing them, taking them away.
 *
 * Split from the wall on purpose. The wall is what somebody opens twenty times a
 * day and it should be nothing but pictures; this is the screen they open when
 * something is wrong or something new arrived.
 */

import { PageHeader } from "@polaris/ui";
import { CamerasView } from "./cameras-view";
import { requireHomeUser } from "@/lib/home/access";

export const dynamic = "force-dynamic";

export default async function CamerasPage({
    searchParams
}: {
    searchParams: Promise<{ open?: string }>;
}) {
    const { canManage } = await requireHomeUser("home.read");
    const { open } = await searchParams;

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <PageHeader
                title="Cameras"
                description="What each camera is, how Polaris reaches it, and what it is allowed to notice."
            />
            <CamerasView canManage={canManage} openId={open ?? null} />
        </div>
    );
}
