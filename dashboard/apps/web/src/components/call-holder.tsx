"use client";

/**
 * Where the call lives while somebody walks around Polaris.
 *
 * A thin wrapper so the layout - a server component - can mount the provider and
 * the bar without knowing anything about calls, and so an instance where nobody
 * has Chat pays for none of it.
 *
 * The bar knows which conversation is on screen, because that is the one place
 * it must not appear: the room is already there, in full.
 */

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { CallBar, CallProvider } from "@/app/(app)/chat/call-session";

export function CallHolder({
    viewerId,
    hasChat,
    children
}: {
    viewerId: string;
    hasChat: boolean;
    children: ReactNode;
}) {
    const pathname = usePathname();
    if (!hasChat) return <>{children}</>;

    // The room being looked at, in either of the two shapes one has: a
    // conversation at `/chat/c/<id>` (with or without a message after it), and a
    // meeting at `/chat/meetings/<id>`. Both are places the call is already
    // drawn in full, which is the one place the bar must not appear.
    const onScreen = /^\/chat\/(?:c|meetings)\/([^/]+)/.exec(pathname)?.[1] ?? null;

    return (
        <CallProvider viewerId={viewerId}>
            <CallBar onScreen={onScreen} />
            {children}
        </CallProvider>
    );
}
