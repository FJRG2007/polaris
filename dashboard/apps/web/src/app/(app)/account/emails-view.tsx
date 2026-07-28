"use client";

/**
 * The addresses on the account. The primary is what signs in, so it is the one
 * row that cannot be removed and the only change that re-asks for the password;
 * everything else is an alternate the user can add, mark as a recovery contact,
 * or drop.
 *
 * Polaris does not send mail, so an alternate is a record of an address the
 * account owns rather than something that gets verified by a link. The copy says
 * as much instead of implying a message is on its way.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy, Mail, Plus } from "lucide-react";
import type { UserEmailView } from "@polaris/auth";
import { emailField } from "@polaris/core";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import {
    addEmailAction,
    promoteEmailAction,
    removeEmailAction,
    setEmailRecoveryAction
} from "./actions";

export function EmailsView({ emails }: { emails: UserEmailView[] }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [adding, setAdding] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [promoting, setPromoting] = useState<UserEmailView | null>(null);

    const candidate = emailField.safeParse(adding);
    const known = new Set(emails.map((entry) => entry.email.toLowerCase()));
    const duplicate = candidate.success && known.has(candidate.data.toLowerCase());

    async function run(key: string, action: () => Promise<{ error?: string }>) {
        setBusy(key);
        setError(null);
        const result = await action();
        setBusy(null);
        if (result.error) setError(result.error);
        else router.refresh();
        return !result.error;
    }

    async function onAdd(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!candidate.success || duplicate) return;
        const ok = await run("add", () => addEmailAction(candidate.data));
        if (ok) setAdding("");
    }

    async function remove(entry: UserEmailView) {
        const ok = await confirm({
            title: "Remove this address?",
            description: `${entry.email} will no longer be on your account.`,
            confirmLabel: "Remove",
            danger: true
        });
        if (!ok || !entry.id) return;
        await run(entry.id, () => removeEmailAction(entry.id));
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-md border border-border">
                {emails.map((entry) => (
                    <div
                        key={entry.email}
                        className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 first:border-t-0"
                    >
                        <div className="flex min-w-0 items-center gap-2">
                            {entry.recovery ? (
                                <LifeBuoy className="size-4 shrink-0 text-muted-foreground" />
                            ) : (
                                <Mail className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="truncate text-sm">{entry.email}</span>
                            {entry.primary ? <Badge variant="primary">Primary</Badge> : null}
                            {entry.recovery ? <Badge>Recovery</Badge> : null}
                        </div>
                        {entry.primary ? null : (
                            <div className="flex shrink-0 items-center gap-1">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy === entry.id}
                                    onClick={() =>
                                        void run(entry.id ?? "", () =>
                                            setEmailRecoveryAction(entry.id, !entry.recovery)
                                        )
                                    }
                                >
                                    {entry.recovery ? "Not for recovery" : "Use for recovery"}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setPromoting(entry)}>
                                    Make primary
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy === entry.id}
                                    onClick={() => void remove(entry)}
                                >
                                    Remove
                                </Button>
                            </div>
                        )}
                    </div>
                ))}
            </div>

            <form onSubmit={onAdd} className="flex flex-col gap-1">
                <div className="flex items-start gap-2">
                    <Input
                        type="email"
                        value={adding}
                        placeholder="another@example.com"
                        autoComplete="email"
                        onChange={(event) => setAdding(event.target.value)}
                    />
                    <Button type="submit" disabled={busy === "add" || !candidate.success || duplicate}>
                        <Plus className="size-4" />
                        Add
                    </Button>
                </div>
                {duplicate ? (
                    <p className="text-xs text-danger">That address is already on your account.</p>
                ) : (
                    <p className="text-xs text-muted-foreground">
                        A recovery address is where an operator can reach you if you lose access.
                    </p>
                )}
            </form>

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <PromoteEmailDialog
                entry={promoting}
                onOpenChange={(open) => !open && setPromoting(null)}
                onDone={() => {
                    setPromoting(null);
                    router.refresh();
                }}
            />
            {confirmElement}
        </div>
    );
}

/** Promoting an alternate changes what signs in, so it re-asks for the password. */
function PromoteEmailDialog({
    entry,
    onOpenChange,
    onDone
}: {
    entry: UserEmailView | null;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!entry?.id) return;
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const result = await promoteEmailAction(entry.id, password);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onDone();
    }

    return (
        <Dialog open={entry !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Make this your primary address?</DialogTitle>
                    <DialogDescription>
                        You will sign in with {entry?.email}. The current one stays on your account.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Current password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {busy ? "Working..." : "Make primary"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
