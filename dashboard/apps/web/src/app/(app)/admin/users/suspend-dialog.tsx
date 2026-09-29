"use client";

/**
 * Shutting one account, from the directory.
 *
 * A dialog rather than a confirmation, because shutting somebody out is two
 * decisions and not one: how long for, and why. The reason is kept on the record
 * and is what the next administrator to look at this account reads instead of
 * guessing; the length is what decides whether the account comes back on its own
 * or waits for somebody to remember it.
 *
 * The same two answers the account's own page asks for. This exists so that
 * shutting somebody out does not require opening their record first - the
 * directory is where an operator is when they decide it.
 */

import { useState } from "react";
import { Ban } from "lucide-react";
import { banUserAction } from "./actions";
import { useRouter } from "next/navigation";
import { banLengthOptions, banVerb } from "./ban-lengths";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

export function SuspendDialog({
    person,
    onOpenChange
}: {
    /** Who is being shut out, or null when the dialog is closed. */
    person: { readonly id: string; readonly name: string } | null;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const router = useRouter();
    const [reason, setReason] = useState("");
    const [length, setLength] = useState("1440");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    if (!person) return null;

    const minutes = Number(length) || 0;

    async function submit() {
        if (!person) return;
        setBusy(true);
        setError("");
        const result = await banUserAction(person.id, reason, minutes);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setReason("");
        onOpenChange(false);
        router.refresh();
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {minutes > 0
                            ? t("users.ban.suspendTitle", { name: person.name })
                            : t("users.ban.banTitle", { name: person.name })}
                    </DialogTitle>
                    <DialogDescription>{t("users.ban.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("users.ban.reason")}
                        <Input
                            value={reason}
                            placeholder={t("users.ban.reasonPlaceholder")}
                            onChange={(event) => setReason(event.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("users.ban.length")}
                        <Select
                            value={length}
                            aria-label={t("users.ban.length")}
                            onValueChange={setLength}
                            options={banLengthOptions(t)}
                        />
                    </label>
                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => void submit()}>
                        <Ban className="size-4" />
                        {busy ? t("users.ban.working") : banVerb(t, minutes)}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
