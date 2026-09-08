"use client";

/**
 * The conversations that are in the other chat.
 *
 * Only somebody in an organization that keeps its own chat has two, and only
 * then does this draw anything. It exists because the badge on the Chat entry
 * counts every message waiting anywhere - a message that arrives and says
 * nothing is worse than one in the wrong place - so the rail has to be able to
 * account for a number larger than the list under it. This is that account: one
 * line per other chat, named, with what is waiting in it, and it moves the shelf
 * when it is pressed.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { ArrowLeftRight } from "lucide-react";
import { conversationsElsewhereAction } from "./actions";
import { useEffect, useState, useTransition } from "react";
import type { ChatElsewhere } from "@/lib/chat/chat-service";
import { setWorkspaceScopeAction } from "@/app/(app)/scope-actions";

export function Elsewhere({
    /** Changes whenever the rail is rebuilt, which is when the counts here can
     *  have moved. */
    revision
}: {
    revision: unknown;
}) {
    const router = useRouter();
    const [chats, setChats] = useState<readonly ChatElsewhere[]>([]);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let alive = true;
        void runAction(conversationsElsewhereAction, () => undefined).then((result) => {
            if (alive && result?.chats) setChats(result.chats);
        });
        return () => {
            alive = false;
        };
    }, [revision]);

    if (chats.length === 0) return null;

    const go = (orgId: string | null) => {
        startTransition(async () => {
            await setWorkspaceScopeAction(
                orgId ? core.formatScope({ kind: "org", orgId }) : core.PERSONAL_SCOPE
            );
            router.refresh();
        });
    };

    return (
        <div className="mt-3 flex flex-col gap-0.5 border-t border-border pt-3">
            <p className="text-foreground-subtle px-2 pb-1 text-xs">Somewhere else</p>
            {chats.map((chat) => (
                <button
                    key={chat.orgId ?? "shared"}
                    type="button"
                    disabled={pending}
                    onClick={() => go(chat.orgId)}
                    className={cn(
                        "hover:bg-card-hover flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors",
                        "text-muted-foreground disabled:opacity-60"
                    )}
                >
                    <ArrowLeftRight className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={chat.name}>
                        {chat.name}
                    </span>
                    {chat.unread > 0 ? (
                        <span className="bg-primary text-primary-foreground shrink-0 rounded-full px-1.5 text-[11px] leading-5">
                            {chat.unread > 99 ? "99+" : chat.unread}
                        </span>
                    ) : (
                        <span className="text-foreground-subtle shrink-0 text-xs">
                            {chat.conversations}
                        </span>
                    )}
                </button>
            ))}
        </div>
    );
}
