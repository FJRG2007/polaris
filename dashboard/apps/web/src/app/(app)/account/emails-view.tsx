"use client";

/**
 * The addresses on the account. The primary is what signs in, so it is the one
 * row that cannot be removed and the only change that re-asks for the password;
 * everything else is an alternate the user can add, mark as a recovery contact,
 * or drop.
 *
 * An address is added without proof - an operator may want to record one they
 * cannot receive at - and Verify is what upgrades it into something the account
 * system will send a reset or a sign-in code to. With no email channel set up
 * there is nothing to send with, so the control says so rather than failing on
 * being pressed.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy, Mail, Plus, Star, Trash2 } from "lucide-react";
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
    Input,
    cn
} from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import {
    addEmailAction,
    promoteEmailAction,
    removeEmailAction,
    setEmailRecoveryAction,
    verifyEmailAction
} from "./actions";

export function EmailsView({ emails, mailReady }: { emails: UserEmailView[]; mailReady: boolean }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [adding, setAdding] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [promoting, setPromoting] = useState<UserEmailView | null>(null);

    const candidate = emailField.safeParse(adding);
    const known = new Set(emails.map((entry) => entry.email.toLowerCase()));
    const duplicate = candidate.success && known.has(candidate.data.toLowerCase());

    async function run(key: string, action: () => Promise<{ error?: string }>) {
        setBusy(key);
        setError(null);
        setNotice(null);
        const result = await action();
        setBusy(null);
        if (result.error) setError(result.error);
        else router.refresh();
        return !result.error;
    }

    /** Ask for a confirmation link. Nothing on the page changes until the link is
     *  clicked, so the only feedback is saying where it went. */
    async function verify(entry: UserEmailView) {
        const key = entry.id ?? "primary";
        setBusy(key);
        setError(null);
        setNotice(null);
        const result = await verifyEmailAction(entry.email);
        setBusy(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        setNotice(`Confirmation link sent to ${entry.email}.`);
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
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 first:border-t-0"
                    >
                        <div className="flex min-w-0 flex-1 basis-64 items-center gap-2">
                            <Mail className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm" title={entry.email}>
                                {entry.email}
                            </span>
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-1.5">
                            {entry.primary ? <Badge variant="primary">Primary</Badge> : null}
                            {entry.recovery ? <Badge>Recovery</Badge> : null}
                            {entry.verified ? (
                                <Badge className="border-success/40 text-success">Verified</Badge>
                            ) : (
                                <Badge className="border-warning/40 text-warning">Unverified</Badge>
                            )}
                            {entry.verified ? null : (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={!mailReady || busy === (entry.id ?? "primary")}
                                    title={
                                        mailReady
                                            ? undefined
                                            : "No email channel is set up, so Polaris cannot send the link."
                                    }
                                    onClick={() => void verify(entry)}
                                >
                                    Verify
                                </Button>
                            )}
                            {entry.primary ? null : (
                                <>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={
                                            entry.recovery
                                                ? `Stop using ${entry.email} for recovery`
                                                : `Use ${entry.email} for recovery`
                                        }
                                        title={entry.recovery ? "Not for recovery" : "Use for recovery"}
                                        disabled={busy === entry.id}
                                        onClick={() =>
                                            void run(entry.id ?? "", () =>
                                                setEmailRecoveryAction(entry.id, !entry.recovery)
                                            )
                                        }
                                    >
                                        <LifeBuoy className={cn("size-4", entry.recovery && "text-primary")} />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Make ${entry.email} primary`}
                                        title="Make primary"
                                        onClick={() => setPromoting(entry)}
                                    >
                                        <Star className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Remove ${entry.email}`}
                                        title="Remove"
                                        disabled={busy === entry.id}
                                        onClick={() => void remove(entry)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </>
                            )}
                        </div>
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
            {notice ? <p className="text-sm text-success">{notice}</p> : null}

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
