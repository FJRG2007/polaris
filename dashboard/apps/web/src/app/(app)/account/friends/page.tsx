/**
 * Friends (/account/friends): who counts as one, and who is waiting.
 */

import { requireUser } from "@/lib/session";
import { FriendsView } from "./friends-view";
import { listFriendsPage, listRequests } from "@/lib/friends-service";

export const dynamic = "force-dynamic";

export default async function FriendsPage() {
    const session = await requireUser();
    // The first page only. The screen asks for the rest as it is scrolled, so a
    // thousand friends is a thousand rows over time rather than in one render.
    const [friends, requests] = await Promise.all([
        listFriendsPage(session.id),
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
            <FriendsView friends={friends.items} requests={requests} more={friends.cursor} />
        </div>
    );
}
