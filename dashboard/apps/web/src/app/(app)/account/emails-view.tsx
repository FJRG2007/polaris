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
 *
 * Laid out as every list in Polaris is: a table, each row's actions behind its
 * three dots, and "Add email" in the header opening a dialog.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy, Mail, MoreHorizontal, Plus, Send, Star, Trash2 } from "lucide-react";
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input
} from "@polaris/ui";
import { SectionCard } from "./section-card";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SlowSubmitLabel } from "@/components/slow-submit-label";
import {
    addEmailAction,
    promoteEmailAction,
    promoteEmailOpaqueAction,
    removeEmailAction,
    setEmailRecoveryAction,
    verifyEmailAction
} from "./actions";

export function EmailsView({ emails, mailReady }: { emails: UserEmailView[]; mailReady: boolean; }) {
    const router = useRouter();
    const t = useTranslations("account");
    const [confirm, confirmElement] = useConfirm();
    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [promoting, setPromoting] = useState<UserEmailView | null>(null);

    async function run(key: string, action: () => Promise<{ error?: string; }>) {
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
        setNotice(t("emails.linkSent", { email: entry.email }));
    }

    async function remove(entry: UserEmailView) {
        const ok = await confirm({
            title: t("emails.removeTitle"),
            description: t("emails.removeDescription", { email: entry.email }),
            confirmLabel: t("emails.remove"),
            danger: true
        });
        if (!ok || !entry.id) return;
        await run(entry.id, () => removeEmailAction(entry.id));
    }

    return (
        <SectionCard
            title={t("emails.title")}
            description={t("emails.description")}
            action={
                <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    {t("emails.addEmail")}
                </Button>
            }
        >
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-start text-xs text-muted-foreground">
                        <tr>
                            <th scope="col" className="w-full max-w-0 px-3 py-2 text-start font-medium">
                                {t("emails.columns.address")}
                            </th>
                            <th scope="col" className="hidden px-3 py-2 text-start font-medium sm:table-cell">
                                {t("emails.columns.state")}
                            </th>
                            <th scope="col" className="px-3 py-2">
                                <span className="sr-only">{t("emails.columns.actions")}</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {emails.map((entry) => (
                            <EmailRow
                                key={entry.email}
                                entry={entry}
                                mailReady={mailReady}
                                busy={busy === (entry.id ?? "primary")}
                                onVerify={() => void verify(entry)}
                                onRecovery={() =>
                                    void run(entry.id ?? "", () => setEmailRecoveryAction(entry.id, !entry.recovery))
                                }
                                onPromote={() => setPromoting(entry)}
                                onRemove={() => void remove(entry)}
                            />
                        ))}
                    </tbody>
                </table>
            </div>

            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {notice ? <p className="text-sm text-success">{notice}</p> : null}

            <AddEmailDialog
                open={adding}
                emails={emails}
                onOpenChange={setAdding}
                onDone={() => {
                    setAdding(false);
                    router.refresh();
                }}
            />
            <PromoteEmailDialog
                entry={promoting}
                onOpenChange={(open) => !open && setPromoting(null)}
                onDone={() => {
                    setPromoting(null);
                    router.refresh();
                }}
            />
            {confirmElement}
        </SectionCard>
    );
}

function EmailBadges({ entry }: { entry: UserEmailView; }) {
    const t = useTranslations("account");
    return (
        <span className="flex flex-wrap items-center gap-1.5">
            {entry.primary ? <Badge variant="primary">{t("emails.primary")}</Badge> : null}
            {entry.recovery ? <Badge>{t("emails.recovery")}</Badge> : null}
            {entry.verified ? (
                <Badge className="border-success-edge text-success">{t("emails.verified")}</Badge>
            ) : (
                <Badge className="border-warning-edge text-warning">{t("emails.unverified")}</Badge>
            )}
        </span>
    );
}

function EmailRow({
    entry,
    mailReady,
    busy,
    onVerify,
    onRecovery,
    onPromote,
    onRemove
}: {
    entry: UserEmailView;
    mailReady: boolean;
    busy: boolean;
    onVerify: () => void;
    onRecovery: () => void;
    onPromote: () => void;
    onRemove: () => void;
}) {
    const t = useTranslations("account");
    // The primary is what signs in: it can only be verified from here.
    const hasMenu = !entry.primary || !entry.verified;
    return (
        <tr className="border-t border-border">
            <td className="max-w-0 px-3 py-2 align-top">
                <span className="flex min-w-0 items-center gap-2">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={entry.email}>
                        {entry.email}
                    </span>
                </span>
                <span className="mt-1 flex sm:hidden">
                    <EmailBadges entry={entry} />
                </span>
            </td>
            <td className="hidden whitespace-nowrap px-3 py-2 align-top sm:table-cell">
                <EmailBadges entry={entry} />
            </td>
            <td className="px-3 py-2 align-top">
                <span className="flex justify-end">
                    {hasMenu ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("emails.menuFor", { email: entry.email })}
                                    title={t("emails.more")}
                                    aria-busy={busy || undefined}
                                >
                                    <MoreHorizontal className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                                {entry.verified ? null : (
                                    <DropdownMenuItem
                                        disabled={!mailReady || busy}
                                        title={mailReady ? undefined : t("emails.noChannel")}
                                        onSelect={onVerify}
                                    >
                                        <Send className="size-3.5" />
                                        <span className="flex min-w-0 flex-col">
                                            {t("emails.verify")}
                                            {mailReady ? null : (
                                                <span className="text-xs text-muted-foreground">{t("emails.noChannel")}</span>
                                            )}
                                        </span>
                                    </DropdownMenuItem>
                                )}
                                {entry.primary ? null : (
                                    <>
                                        <DropdownMenuItem onSelect={onPromote}>
                                            <Star className="size-3.5" />
                                            {t("emails.makePrimary")}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem disabled={busy} onSelect={onRecovery}>
                                            <LifeBuoy className="size-3.5" />
                                            {entry.recovery ? t("emails.notForRecovery") : t("emails.forRecovery")}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem variant="danger" disabled={busy} onSelect={onRemove}>
                                            <Trash2 className="size-3.5" />
                                            {t("emails.remove")}
                                        </DropdownMenuItem>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <span className="size-9" aria-hidden />
                    )}
                </span>
            </td>
        </tr>
    );
}

/** An address is added without proof; the field is checked as it is typed against
 *  the same schema the server uses and against the addresses already listed. */
function AddEmailDialog({
    open,
    emails,
    onOpenChange,
    onDone
}: {
    open: boolean;
    emails: UserEmailView[];
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [draft, setDraft] = useState("");
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setDraft("");
        setTouched(false);
        setError(null);
    }, [open]);

    const candidate = emailField.safeParse(draft);
    const known = new Set(emails.map((entry) => entry.email.toLowerCase()));
    const duplicate = candidate.success && known.has(candidate.data.toLowerCase());
    // An empty field is incomplete, not wrong: the message waits for something typed.
    const invalid = touched && draft.trim().length > 0 && !candidate.success;
    const ready = candidate.success && !duplicate && !busy;

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setTouched(true);
        if (!candidate.success || duplicate) return;
        setBusy(true);
        setError(null);
        const result = await addEmailAction(candidate.data).catch(() => ({ error: t("emails.addFailed") }));
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onDone();
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("emails.addTitle")}</DialogTitle>
                    <DialogDescription>{t("emails.recoveryHint")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("emails.columns.address")} *
                        <Input
                            type="email"
                            value={draft}
                            placeholder="another@example.com" // i18n-ignore an example address
                            autoComplete="email"
                            autoFocus
                            aria-invalid={invalid || duplicate || undefined}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => draft && setTouched(true)}
                        />
                        {duplicate ? (
                            <span className="text-xs text-danger">{t("emails.duplicate")}</span>
                        ) : invalid ? (
                            <span className="text-xs text-danger">{t("emails.invalid")}</span>
                        ) : null}
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy} aria-disabled={!ready || undefined}>
                            {t("emails.add")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
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
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [busy, setBusy] = useState(false);
    const [protecting, setProtecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Over OPAQUE when the account can, so the password never leaves this
     *  browser; null means the old action (not moved yet, or the worker or the
     *  network failed before anything was sent). */
    async function promoteOverOpaque(emailId: string, password: string): Promise<{ error?: string } | null> {
        const flows = await import("@/lib/chat/e2ee/password-flows-client").catch(() => null);
        if (!flows || !(await flows.opaquePasswordReady())) return null;
        setProtecting(true);
        try {
            return await promoteEmailOpaqueAction(emailId, await flows.provePassword(password));
        } catch {
            return null;
        }
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!entry?.id) return;
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setProtecting(false);
        setError(null);
        const result = (await promoteOverOpaque(entry.id, password)) ?? (await promoteEmailAction(entry.id, password));
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
                    <DialogTitle>{t("emails.promoteTitle")}</DialogTitle>
                    <DialogDescription>{t("emails.promoteDescription", { email: entry?.email ?? "" })}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("emails.currentPassword")}
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {busy ? (
                                <SlowSubmitLabel busyLabel={t("emails.working")} protecting={protecting} />
                            ) : (
                                t("emails.makePrimary")
                            )}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
