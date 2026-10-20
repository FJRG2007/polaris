"use client";

/**
 * A chat somebody sent you, read-only. "Continue in my own chat" copies it into
 * a new chat of yours and opens it; "Remove from my list" takes it off Shared
 * with you.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@polaris/ui";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import type { ReceivedPolarThread } from "@/lib/polar/shared";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SharedMessages } from "@/components/polar/shared-transcript";

export function ReceivedChat({ id, thread }: { id: string; thread: ReceivedPolarThread }) {
    const t = useTranslations("polar");
    const toast = useToast();
    const router = useRouter();
    const [working, setWorking] = useState(false);
    const date = new Date(thread.sharedAt).toLocaleDateString(undefined, { dateStyle: "medium" });

    const carryOn = async () => {
        setWorking(true);
        const response = await fetch(`/api/polar/shared/${id}/continue`, { method: "POST" }).catch(
            () => null
        );
        if (!response?.ok) {
            setWorking(false);
            toast.show({ title: t("sharing.continueFailed") });
            return;
        }
        const { threadId } = (await response.json()) as { threadId: string };
        router.push(`/polar?thread=${threadId}`);
    };

    const dismiss = async () => {
        setWorking(true);
        const response = await fetch(`/api/polar/shared/${id}`, { method: "DELETE" }).catch(
            () => null
        );
        if (!response?.ok) {
            setWorking(false);
            toast.show({ title: t("sharing.dismissFailed") });
            return;
        }
        router.push("/polar");
    };

    return (
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 py-4">
            <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                    <h1 className="break-words text-xl font-semibold text-foreground">
                        {thread.title}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t("sharing.from", { name: thread.from ?? t("sharing.somebody") })}
                        {" - "}
                        {t("sharing.sharedOn", { date })}
                    </p>
                    {thread.note ? (
                        <p className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-sm text-foreground">
                            {thread.note}
                        </p>
                    ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        disabled={working}
                        onClick={() => void dismiss()}
                    >
                        <Trash2 className="size-4" />
                        {t("sharing.dismiss")}
                    </Button>
                    <Button type="button" disabled={working} onClick={() => void carryOn()}>
                        <MessageSquarePlus className="size-4" />
                        {t("sharing.continue")}
                    </Button>
                </div>
            </header>
            <SharedMessages
                messages={thread.messages}
                fileUrl={(fileId) => `/api/polar/shared/${id}/files/${fileId}`}
            />
            <p className="text-xs text-foreground-subtle">{t("sharing.readOnly")}</p>
        </div>
    );
}
