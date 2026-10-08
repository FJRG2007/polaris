"use client";

/**
 * The gate in front of an age-restricted channel, Discord's way.
 *
 * Drawn in place of the conversation - no message is read until the reader
 * answers, because the server refuses to hand any over until they do (see
 * `lib/chat/age-gate.ts`). "Continue" is remembered for this channel; "Go back"
 * leaves without saying anything.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { confirmAgeAction } from "./actions";
import { ShieldAlert, Loader2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function AgeGate({
    channelId,
    channelName,
    onConfirmed
}: {
    channelId: string;
    channelName: string;
    onConfirmed: () => void;
}) {
    const t = useTranslations("chat");
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const confirm = async () => {
        setBusy(true);
        setError("");
        const result = await runAction(() => confirmAgeAction(channelId), setError);
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        onConfirmed();
    };

    return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
            <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning-ink">
                    <ShieldAlert className="size-6 shrink-0" />
                </span>
                <h2 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("ageGate.title")}
                </h2>
                <p className="text-sm text-muted-foreground">
                    {t("ageGate.description", { name: channelName })}
                </p>
                <div className="flex flex-wrap justify-center gap-2 pt-1">
                    <Button variant="secondary" size="sm" onClick={() => router.push("/chat")}>
                        {t("ageGate.goBack")}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void confirm()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("ageGate.continue")}
                    </Button>
                </div>
                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </div>
        </div>
    );
}
