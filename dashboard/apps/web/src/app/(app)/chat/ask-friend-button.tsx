"use client";

/**
 * The way past "not your friend yet", beside the name it is about.
 *
 * A group picker that greys somebody out for not being a friend owes the reader
 * the next step, and the next step is a request. Offered only when their own
 * setting would take one (`requestable`), so it is never pressed and refused.
 * Optimistic: it reads as sent the moment it is pressed, and goes back with the
 * reason if the request did not go.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { Check, UserPlus } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { askFriendAction } from "./actions";

export function AskFriendButton({ personId, name }: { personId: string; name: string }) {
    const t = useTranslations("chat");
    const [sent, setSent] = useState(false);
    const [error, setError] = useState("");

    const ask = async () => {
        setSent(true);
        setError("");
        const result = await askFriendAction(personId).catch(() => ({
            error: t("groupPicker.requestFailed")
        }));
        if (result.error) {
            setSent(false);
            setError(result.error);
        }
    };

    if (sent) {
        return (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Check className="size-3.5" />
                {t("groupPicker.requestSent")}
            </span>
        );
    }
    return (
        <span className="flex shrink-0 flex-col items-end gap-0.5">
            <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-xs"
                aria-label={t("groupPicker.sendRequestTo", { name })}
                onClick={() => void ask()}
            >
                <UserPlus className="size-3.5" />
                {t("groupPicker.sendRequest")}
            </Button>
            {error && (
                <span
                    role="alert"
                    className="max-w-[10rem] truncate text-xs text-danger"
                    title={error}
                >
                    {error}
                </span>
            )}
        </span>
    );
}
