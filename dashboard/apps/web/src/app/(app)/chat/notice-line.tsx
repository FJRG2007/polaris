"use client";

import { usePersonPress } from "@/components/person-press";
import type { ChatMessageView } from "@/lib/chat/messages";

/**
 * A line Polaris wrote, with each person it names pressable - the same card a
 * mention or an author's name opens, as Discord's "added" lines do. The plain
 * sentence where the pieces are not there (a page read by an older server).
 */
export function NoticeText({ message }: { message: ChatMessageView }) {
    const press = usePersonPress();
    if (!message.notice) return <>{message.body}</>;
    return (
        <>
            {message.notice.map((part, at) =>
                "text" in part ? (
                    <span key={at}>{part.text}</span>
                ) : press ? (
                    <button
                        key={at}
                        type="button"
                        onClick={(event) =>
                            press({ id: part.userId, name: part.name }, event.currentTarget)
                        }
                        className="rounded font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                    >
                        {part.name}
                    </button>
                ) : (
                    <span key={at} className="font-medium text-foreground">
                        {part.name}
                    </span>
                )
            )}
        </>
    );
}
