"use client";

/**
 * A shared Polar chat, read-only: the question on the right, the answer below
 * it, the way the chat itself lays them out.
 */

import { cn } from "@polaris/ui";
import { PublicShell } from "@/components/public-shell";
import type { SharedPolarThread } from "@/lib/polar/share";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MessageResponse } from "@/components/polar/elements/message";

export function SharedChat({ thread, signedIn }: { thread: SharedPolarThread; signedIn: boolean }) {
    const t = useTranslations("publicPages");
    const date = new Date(thread.sharedAt).toLocaleDateString(undefined, { dateStyle: "medium" });
    return (
        <PublicShell signedIn={signedIn} className="max-w-3xl">
            <header className="min-w-0 space-y-1">
                <h1 className="break-words text-xl font-semibold text-foreground">
                    {thread.title}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {t("polarShare.sharedOn", { date })}
                </p>
            </header>
            {thread.messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("polarShare.empty")}</p>
            ) : (
                <ol className="flex min-w-0 flex-col gap-4">
                    {thread.messages.map((message) => (
                        <li
                            key={message.id}
                            className={cn(
                                "min-w-0",
                                message.role === "user" &&
                                    "ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground"
                            )}
                        >
                            <span className="sr-only">
                                {t(message.role === "user" ? "polarShare.you" : "polarShare.assistant")}
                            </span>
                            {message.role === "user" ? (
                                message.text
                            ) : (
                                <MessageResponse>{message.text}</MessageResponse>
                            )}
                        </li>
                    ))}
                </ol>
            )}
            <p className="text-xs text-foreground-subtle">{t("polarShare.readOnly")}</p>
        </PublicShell>
    );
}
