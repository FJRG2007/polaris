"use client";

/**
 * Handing a task to somebody.
 *
 * Three ways out, in the order people reach for them. Sending it to a colleague
 * is the common case and sits at the top. The private link is the one to paste
 * in a chat: it opens for anybody who can already see the space and for nobody
 * else. The public link is the deliberate one - it is off until somebody turns
 * it on, it says plainly what it exposes, and turning it off kills the token for
 * good rather than parking it.
 *
 * An address that is not a Polaris account can only be sent the public link,
 * which is why the send button says so instead of quietly mailing a link the
 * recipient would land on a sign-in page with.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { schemaMessage } from "./schema-message";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { AssigneePicker, Avatar } from "./pickers";
import type { PersonRef } from "@/lib/tasks/facts";
import { CopyButton } from "@/components/copy-button";
import type { TaskShareView } from "@/lib/tasks/share-service";
import { PersonName, PersonRow } from "@/components/person-name";
import { Globe, Link2, Loader2, Mail, UserPlus, X } from "lucide-react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Switch,
    Textarea,
    cn
} from "@polaris/ui";

/** A link in a box with the copy control, the same shape in both blocks. */
function LinkRow({ url, label }: { url: string; label: string }) {
    return (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <input
                readOnly
                value={url}
                aria-label={label}
                onFocus={(event) => event.target.select()}
                className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
            />
            <CopyButton value={url} label={label} />
        </div>
    );
}

function Section({
    icon,
    title,
    hint,
    children
}: {
    icon: React.ReactNode;
    title: string;
    hint: string;
    children: React.ReactNode;
}) {
    return (
        <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{icon}</span>
                <h3 className="text-sm font-medium">{title}</h3>
            </div>
            <p className="text-xs text-muted-foreground">{hint}</p>
            {children}
        </section>
    );
}

export function ShareDialog({
    taskId,
    taskName,
    people,
    currentUserId,
    open,
    onOpenChange
}: {
    taskId: string;
    taskName: string;
    people: readonly PersonRef[];
    currentUserId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("tasksDetail");
    const tt = useTranslations("tasks");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [privateUrl, setPrivateUrl] = useState("");
    const [canShare, setCanShare] = useState(false);
    const [share, setShare] = useState<TaskShareView | null>(null);

    const [userIds, setUserIds] = useState<string[]>([]);
    const [emails, setEmails] = useState<string[]>([]);
    const [draftEmail, setDraftEmail] = useState("");
    const [note, setNote] = useState("");
    const [sending, setSending] = useState(false);
    const [outcome, setOutcome] = useState<{ sent: string[]; failures: { recipient: string; reason: string }[] } | null>(
        null
    );

    useEffect(() => {
        if (!open) return;
        setLoading(true);
        setError("");
        setOutcome(null);
        void (async () => {
            const result = await runAction(() => actions.getTaskShareAction(taskId), setError);
            if (result?.error) setError(result.error);
            setPrivateUrl(result?.privateUrl ?? "");
            setShare(result?.share ?? null);
            setCanShare(result?.canShare ?? false);
            setLoading(false);
        })();
    }, [open, taskId]);

    const others = people.filter((person) => person.id !== currentUserId);
    const chosen = others.filter((person) => userIds.includes(person.id));
    const hasOutsider = emails.length > 0;
    const blockedOutside = hasOutsider && !share;

    const addEmail = () => {
        const parsed = core.emailField.safeParse(draftEmail);
        if (!parsed.success) {
            setError(schemaMessage(tt, parsed.error.issues[0]?.message, t("share.validEmail")));
            return;
        }
        const address = parsed.data.toLowerCase();
        setError("");
        setDraftEmail("");
        setEmails((current) => (current.includes(address) ? current : [...current, address]));
    };

    /** Flip the public link, showing the new state at once and putting it back if
     *  the write is refused. */
    const setPublic = async (enabled: boolean, showComments: boolean) => {
        const previous = share;
        setError("");
        setShare(enabled ? { url: previous?.url ?? "", showComments, views: previous?.views ?? 0, createdAt: "" } : null);
        const result = await runAction(
            () => actions.setTaskShareAction({ taskId, enabled, showComments }),
            setError
        );
        if (result?.error) {
            setError(result.error);
            setShare(previous);
            return;
        }
        setShare(result?.share ?? null);
    };

    const send = async () => {
        setSending(true);
        setError("");
        setOutcome(null);
        const result = await runAction(
            () => actions.sendTaskShareAction({ taskId, userIds, emails, note }),
            setError
        );
        setSending(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setOutcome({ sent: result?.sent ?? [], failures: result?.failures ?? [] });
        setUserIds([]);
        setEmails([]);
        setNote("");
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(32rem,96vw)] max-w-[min(32rem,96vw)]">
                <DialogHeader>
                    <DialogTitle>{t("share.title")}</DialogTitle>
                    <DialogDescription className="truncate">{taskName}</DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex h-40 items-center justify-center text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                    </div>
                ) : (
                    <div className="flex flex-col gap-6">
                        {error && (
                            <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                                {error}
                            </p>
                        )}

                        {canShare && (
                            <Section
                                icon={<Mail className="size-4" />}
                                title={t("share.send.title")}
                                hint={t("share.send.hint")}
                            >
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {chosen.map((person) => (
                                        <PersonRow
                                            as="span"
                                            key={person.id}
                                            personId={person.id}
                                            className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pl-0.5 pr-2 text-xs"
                                        >
                                            <Avatar person={person} size={18} />
                                            <PersonName id={person.id} name={person.name} />
                                            <button
                                                type="button"
                                                aria-label={t("share.remove", { name: person.name })}
                                                onClick={() =>
                                                    setUserIds((current) =>
                                                        current.filter((id) => id !== person.id)
                                                    )
                                                }
                                                className="text-muted-foreground hover:text-foreground"
                                            >
                                                <X className="size-3" />
                                            </button>
                                        </PersonRow>
                                    ))}
                                    {emails.map((address) => (
                                        <span
                                            key={address}
                                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                                        >
                                            {address}
                                            <button
                                                type="button"
                                                aria-label={t("share.remove", { name: address })}
                                                onClick={() =>
                                                    setEmails((current) =>
                                                        current.filter((entry) => entry !== address)
                                                    )
                                                }
                                                className="text-muted-foreground hover:text-foreground"
                                            >
                                                <X className="size-3" />
                                            </button>
                                        </span>
                                    ))}
                                    <AssigneePicker
                                        people={others}
                                        selected={userIds}
                                        onChange={setUserIds}
                                        trigger={
                                            <button
                                                type="button"
                                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                            >
                                                <UserPlus className="size-3.5" />
                                                {t("share.addPeople")}
                                            </button>
                                        }
                                    />
                                </div>

                                <div className="flex items-center gap-2">
                                    <Input
                                        type="email"
                                        value={draftEmail}
                                        placeholder={t("share.emailPlaceholder")}
                                        aria-label={t("share.email")}
                                        onChange={(event) => setDraftEmail(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key !== "Enter") return;
                                            event.preventDefault();
                                            addEmail();
                                        }}
                                        className="h-8 flex-1 text-xs"
                                    />
                                    <Button size="sm" variant="ghost" disabled={!draftEmail.trim()} onClick={addEmail}>
                                        {t("share.add")}
                                    </Button>
                                </div>

                                <Textarea
                                    value={note}
                                    rows={2}
                                    placeholder={t("share.notePlaceholder")}
                                    aria-label={t("share.note")}
                                    onChange={(event) => setNote(event.target.value)}
                                />

                                {blockedOutside && (
                                    <p className="text-xs text-warning">
                                        {t("share.linkOff")}
                                    </p>
                                )}

                                <div className="flex items-center gap-3">
                                    <Button
                                        size="sm"
                                        disabled={sending || (userIds.length === 0 && emails.length === 0)}
                                        onClick={() => void send()}
                                    >
                                        {sending && <Loader2 className="size-3.5 animate-spin" />}
                                        {t("share.sendButton")}
                                    </Button>
                                    {outcome && outcome.sent.length > 0 && (
                                        <span className="text-xs text-muted-foreground">
                                            {t("share.sentTo", { names: outcome.sent.join(", ") })}
                                        </span>
                                    )}
                                </div>

                                {outcome?.failures.map((failure) => (
                                    <p key={failure.recipient} className="text-xs text-danger">
                                        {failure.recipient}: {failure.reason}
                                    </p>
                                ))}
                            </Section>
                        )}

                        <Section
                            icon={<Link2 className="size-4" />}
                            title={t("share.private.title")}
                            hint={t("share.private.hint")}
                        >
                            <LinkRow url={privateUrl} label={t("share.private.label")} />
                        </Section>

                        {canShare && (
                            <Section
                                icon={<Globe className="size-4" />}
                                title={t("share.public.title")}
                                hint={t("share.public.hint")}
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-sm">
                                        {share ? t("share.public.on") : t("share.public.off")}
                                        {share && share.views > 0 && (
                                            <span className="ml-2 text-xs text-muted-foreground">
                                                {t("share.public.opened", { count: share.views })}
                                            </span>
                                        )}
                                    </span>
                                    <Switch
                                        checked={share !== null}
                                        aria-label={t("share.public.title")}
                                        onChange={(checked) => void setPublic(checked, share?.showComments ?? false)}
                                    />
                                </div>
                                <div className={cn("flex flex-col gap-2", !share && "hidden")}>
                                    {share?.url && <LinkRow url={share.url} label={t("share.public.label")} />}
                                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Checkbox
                                            checked={share?.showComments ?? false}
                                            onChange={(event) => void setPublic(true, event.target.checked)}
                                        />
                                        {t("share.public.comments")}
                                    </label>
                                </div>
                            </Section>
                        )}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
