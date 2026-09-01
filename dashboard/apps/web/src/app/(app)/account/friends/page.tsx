/**
 * Friends (/account/friends): who counts as one, and who is waiting.
 */

import { requireUser } from "@/lib/session";
import { FriendsView } from "./friends-view";
import { listFriends, listRequests } from "@/lib/friends-service";

export const dynamic = "force-dynamic";

export default async function FriendsPage() {
    const session = await requireUser();
    const [friends, requests] = await Promise.all([
        listFriends(session.id),
        listRequests(session.id)
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Friends</h1>
                <p className="text-sm text-muted-foreground">
                    Who sees what you show your friends. Being friends grants nothing else.
                </p>
            </div>
            <FriendsView friends={friends} requests={requests} />
        </div>
    );
}
