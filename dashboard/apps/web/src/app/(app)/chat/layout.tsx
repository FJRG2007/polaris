/**
 * Chat (/chat).
 *
 * The layout draws the shell and nothing else - no query is awaited here. Two
 * reasons, and they point the same way: a layout's data does not reliably
 * re-render when the route refreshes, and Chat is the one app where the data
 * changes while you are looking at it. So the conversation list and the messages
 * are fetched by the client that keeps them live, and what the server renders is
 * the part that is the same on every screen.
 *
 * That is also what makes the first paint instant: the rail, the header and the
 * composer are on screen before anything has been asked for, and only the two
 * regions genuinely waiting on an answer carry a skeleton.
 */

import type { ReactNode } from "react";
import { ChatShell } from "./chat-shell";
import { requirePermission } from "@/lib/session";
import { resolveScope } from "@/lib/workspace-scope";

export const dynamic = "force-dynamic";

export default async function ChatLayout({ children }: { children: ReactNode }) {
    const user = await requirePermission("chat.use");
    // The shelf somebody is working from, so a space they start belongs to the
    // organization they are standing in rather than to them personally. It is
    // already memoized for this request by the app shell above.
    const scope = await resolveScope(user.id);

    return (
        <ChatShell
            viewerId={user.id}
            viewerName={user.name}
            orgId={scope.org?.id ?? null}
            orgName={scope.org?.name ?? null}
        >
            {children}
        </ChatShell>
    );
}
