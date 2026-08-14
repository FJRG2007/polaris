/**
 * Activity page (/account/activity): everything this account has done, and from
 * which device. It is the other half of the session list - that page says what
 * is signed in, this one says what those sessions actually did - which is the
 * question somebody asks before deciding whether a session is theirs.
 *
 * It reads the same log the administrator's Activity screen reads, through the
 * same table, narrowed to the reader's own entries.
 */

import { requireUser } from "@/lib/session";
import { ActivityView } from "./activity-view";

export const dynamic = "force-dynamic";

export default async function AccountActivityPage() {
    await requireUser();

    // Held to the width of the other security tables so the two read as one place.
    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Activity</h1>
                <p className="text-sm text-muted-foreground">
                    What has been done with your account, and which device did it.
                </p>
            </div>
            <ActivityView />
        </div>
    );
}
