/** What the app menu lists as waiting: the unread chats and mail of the other scenes. */

import { chatChannels } from "./chat";
import { mailThreads } from "./mail";
import type { SceneContext } from "../runtime/scene";
import type { LauncherWaiting } from "@/lib/launcher-waiting";

export function launcherWaiting(ctx: SceneContext): LauncherWaiting {
    const chats = chatChannels(ctx).filter((channel) => (channel.unread ?? 0) > 0);
    const threads = mailThreads(ctx).filter((thread) => thread.unreadCount > 0);
    return {
        groups: [
            {
                app: "chat",
                total: chats.reduce((sum, channel) => sum + (channel.unread ?? 0), 0),
                items: chats.map((channel) => ({
                    id: channel.id,
                    title: channel.name,
                    detail: "",
                    href: `/chat/c/${channel.id}`,
                    count: channel.unread ?? 0,
                    dismissable: true
                }))
            },
            {
                app: "mail",
                total: threads.reduce((sum, thread) => sum + thread.unreadCount, 0),
                items: threads.slice(0, 5).map((thread) => ({
                    id: thread.id,
                    title: thread.participants[0]?.name ?? "",
                    detail: thread.subject,
                    href: `/mail/t/${thread.id}`,
                    count: thread.unreadCount,
                    dismissable: true
                }))
            }
        ]
    };
}

/** The badges above every screen, which say the same numbers. */
export function launcherUnread(ctx: SceneContext): { chat: number; mail: number } {
    const [chat, mail] = launcherWaiting(ctx).groups;
    return { chat: chat!.total, mail: mail!.total };
}
