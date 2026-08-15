/**
 * Privacy (/account/privacy): what this account shows, and to whom.
 */

import { requireUser } from "@/lib/session";
import { PrivacyView } from "./privacy-view";
import { privacyFor } from "@/lib/privacy-service";
import { listFriends, listRequests } from "@/lib/friends-service";

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
    const session = await requireUser();
    const [settings, friends, requests] = await Promise.all([
        privacyFor(session.id),
        listFriends(session.id),
        listRequests(session.id)
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Privacy</h1>
                <p className="text-sm text-muted-foreground">
                    Who can see when you were last here, that you have read a message, and your
                    photo.
                </p>
            </div>
            <PrivacyView settings={settings} friends={friends} requests={requests} />
        </div>
    );
}
