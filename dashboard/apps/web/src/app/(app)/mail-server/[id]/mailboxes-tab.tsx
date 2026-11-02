"use client";

/**
 * Mailboxes on the server: who has one, how much room it has, which other
 * addresses deliver to it - and a new one, optionally added to your own Mail in
 * the same step so it can be read without typing its servers anywhere.
 */

import { Inbox, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { passwordIsBreached } from "@/lib/pwned-passwords";
import { Field, forgetPanelData, PanelError, usePanelData } from "../ui-bits";
import { mailNoteText, mailSchemaText } from "@/lib/mail-server/words";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import {
    BREACHED_PASSWORD_MESSAGE,
    MAILBOX_IDENTITY_PASSWORD_MESSAGE,
    mailboxCreateSchema,
    passwordMatchesIdentity
} from "@polaris/core";
import {
    createMailboxAction,
    deleteMailboxAction,
    listMailboxesAction,
    setMailboxAliasesAction,
    setMailboxPasswordAction,
    setMailboxQuotaAction
} from "../actions";
import {
    Badge,
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";

type Loaded = Extract<Awaited<ReturnType<typeof listMailboxesAction>>, { mailboxes: unknown }>;
type Mailbox = Loaded["mailboxes"][number];
type Domain = Loaded["domains"][number];

/** A password nobody has to think up: 20 characters from an unambiguous set. */
function generatedPassword(): string {
    const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint32Array(20);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

/**
 * The refusal a mailbox password earns as it is typed: too close to the
 * mailbox's own address, or already in a breach list (asked of the range API a
 * moment after typing stops, and treated as fine when it cannot be asked). The
 * server repeats both on submit; this is only so the answer arrives first.
 */
function usePasswordRefusal(password: string, address: string): string | null {
    const [breached, setBreached] = useState<string | null>(null);
    const identity = password && passwordMatchesIdentity(password, [address]) ? MAILBOX_IDENTITY_PASSWORD_MESSAGE : null;

    useEffect(() => {
        setBreached(null);
        if (password.length < 12 || identity) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void passwordIsBreached(password, controller.signal).then((found) => {
                if (!controller.signal.aborted) setBreached(found ? BREACHED_PASSWORD_MESSAGE : null);
            });
        }, 400);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [password, identity]);

    return identity ?? breached;
}

function quotaLabel(quotaMb: number, t: NamespaceTranslator<"mailServer">): string {
    if (quotaMb <= 0) return t("boxes.noLimit");
    return quotaMb >= 1024 ? `${Math.round((quotaMb / 1024) * 10) / 10} GB` : `${quotaMb} MB`;
}

export function MailboxesTab({ serverId }: { serverId: string }) {
    const t = useTranslations("mailServer");
    const panel = usePanelData(`mailboxes:${serverId}`, () => listMailboxesAction(serverId));
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState<Mailbox | null>(null);
    const [deleting, setDeleting] = useState<Mailbox | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    async function remove(): Promise<void> {
        if (!deleting) return;
        setDeleteError(null);
        const answer = await deleteMailboxAction({ serverId, accountId: deleting.id });
        if (answer.error) {
            setDeleteError(answer.error);
            return;
        }
        setDeleting(null);
        await panel.reload();
    }

    const mailboxes = panel.data?.mailboxes ?? [];
    const domains = panel.data?.domains ?? [];
    const domainName = new Map(domains.map((domain) => [domain.id, domain.name]));

    return (
        <div className="flex flex-col gap-4">
            <div className="flex justify-end">
                <Button size="sm" onClick={() => setCreating(true)} disabled={domains.length === 0}>
                    <Plus />
                    {t("boxes.new")}
                </Button>
            </div>
            {!panel.data ? (
                panel.error ? (
                    <PanelError message={panel.error} onRetry={() => void panel.reload()} />
                ) : (
                    <Skeleton className="h-40 w-full" />
                )
            ) : mailboxes.length === 0 ? (
                <EmptyState icon={<Inbox />} title={t("boxes.none")} description={t("boxes.noneBody")} />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-[0.8125rem]">
                        <thead>
                            <tr className="text-left">
                                <th className="w-full max-w-0 py-1.5 pr-3">{t("boxes.columns.address")}</th>
                                <th className="py-1.5 pr-3">{t("boxes.columns.quota")}</th>
                                <th className="py-1.5 pr-3">{t("boxes.columns.aliases")}</th>
                                <th className="py-1.5" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {mailboxes.map((mailbox) => (
                                <tr key={mailbox.id}>
                                    <td className="w-full max-w-0 py-2 pr-3">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className="truncate text-foreground" title={mailbox.address}>
                                                {mailbox.address}
                                            </span>
                                            {mailbox.polaris ? <Badge>{t("boxes.polaris")}</Badge> : null}
                                        </div>
                                        {mailbox.description ? (
                                            <p className="truncate text-xs text-muted-foreground" title={mailNoteText(t, mailbox.description) ?? undefined}>
                                                {mailNoteText(t, mailbox.description)}
                                            </p>
                                        ) : null}
                                    </td>
                                    <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{quotaLabel(mailbox.quotaMb, t)}</td>
                                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                                        {mailbox.aliases.length === 0
                                            ? "-"
                                            : mailbox.aliases.map((alias) => `${alias.name}@${domainName.get(alias.domainId) ?? "?"}`).join(", ")}
                                    </td>
                                    <td className="whitespace-nowrap py-2 text-right">
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t("boxes.editNamed", { address: mailbox.address })}
                                            title={t("boxes.editNamed", { address: mailbox.address })}
                                            onClick={() => setEditing(mailbox)}
                                        >
                                            <Pencil />
                                        </Button>
                                        {!mailbox.polaris ? (
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={t("boxes.deleteNamed", { address: mailbox.address })}
                                                title={t("boxes.deleteNamed", { address: mailbox.address })}
                                                onClick={() => setDeleting(mailbox)}
                                            >
                                                <Trash2 />
                                            </Button>
                                        ) : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <CreateDialog
                serverId={serverId}
                domains={domains}
                open={creating}
                onOpenChange={setCreating}
                onCreated={() => {
                    forgetPanelData(`forwards:${serverId}`);
                    void panel.reload();
                }}
            />
            <EditDialog serverId={serverId} mailbox={editing} domains={domains} onClose={() => setEditing(null)} onSaved={() => void panel.reload()} />
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                name={deleting?.address ?? ""}
                kind={t("boxes.kind")}
                description={t("boxes.deleteBody")}
                error={deleteError}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

function CreateDialog({
    serverId,
    domains,
    open,
    onOpenChange,
    onCreated
}: {
    serverId: string;
    domains: readonly Domain[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}) {
    const t = useTranslations("mailServer");
    const tcommon = useTranslations("common");
    const [domainId, setDomainId] = useState("");
    const [localPart, setLocalPart] = useState("");
    const [password, setPassword] = useState("");
    const [quotaMb, setQuotaMb] = useState("2048");
    const [description, setDescription] = useState("");
    const [addToMyMail, setAddToMyMail] = useState(true);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ address: string; warning: string | null } | null>(null);

    const chosenDomain = domainId || domains[0]?.id || "";
    const input = { serverId, domainId: chosenDomain, localPart, password, quotaMb: quotaMb || "0", description, addToMyMail };
    const parsed = mailboxCreateSchema.safeParse(input);
    const address = `${localPart.trim().toLowerCase()}@${domains.find((domain) => domain.id === chosenDomain)?.name ?? ""}`;
    const refusal = usePasswordRefusal(password, address);
    const issue = (path: string, value: string): string | null =>
        parsed.success || !value.trim()
            ? null
            : mailSchemaText(t, parsed.error.issues.find((entry) => entry.path[0] === path)?.message);

    function close(): void {
        setLocalPart("");
        setPassword("");
        setDescription("");
        setError(null);
        setDone(null);
        onOpenChange(false);
    }

    async function submit(): Promise<void> {
        if (!parsed.success || refusal || pending) return;
        setPending(true);
        setError(null);
        const answer = await createMailboxAction(parsed.data);
        setPending(false);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        if ("address" in answer) setDone({ address: answer.address, warning: answer.warning });
        onCreated();
    }

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="w-[min(32rem,95vw)] max-w-[min(32rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>{done ? t("boxes.created") : t("boxes.new")}</DialogTitle>
                    <DialogDescription>{done ? done.address : t("boxes.createIntro")}</DialogDescription>
                </DialogHeader>
                {done ? (
                    <div className="flex flex-col gap-3 text-[0.8125rem]">
                        {done.warning ? (
                            <p className="text-warning">{done.warning}</p>
                        ) : addToMyMail ? (
                            <p className="text-muted-foreground">{t("boxes.inMyMail")}</p>
                        ) : null}
                        <DialogFooter>
                            <Button type="button" onClick={close}>
                                {t("dns.done")}
                            </Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <form
                        className="flex flex-col gap-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void submit();
                        }}
                    >
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field label={t("boxes.name")} required error={issue("localPart", localPart)}>
                                {(id) => <Input id={id} value={localPart} onChange={(event) => setLocalPart(event.target.value)} placeholder="alice" />}
                            </Field>
                            <Field label={t("dns.domain")} required>
                                {(id) => (
                                    <Select
                                        id={id}
                                        value={chosenDomain}
                                        onValueChange={setDomainId}
                                        options={domains.map((domain) => ({ value: domain.id, label: `@${domain.name}` }))}
                                    />
                                )}
                            </Field>
                        </div>
                        <Field
                            label={t("boxes.password")}
                            required
                            error={issue("password", password) ?? mailSchemaText(t, refusal ?? undefined)}
                            hint={t("boxes.passwordHint")}
                        >
                            {(id) => (
                                <div className="flex gap-2">
                                    <Input
                                        id={id}
                                        type="password"
                                        value={password}
                                        onChange={(event) => setPassword(event.target.value)}
                                        autoComplete="new-password"
                                    />
                                    <Button type="button" variant="outline" onClick={() => setPassword(generatedPassword())}>
                                        {t("boxes.generate")}
                                    </Button>
                                </div>
                            )}
                        </Field>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field label={t("boxes.quota")} error={issue("quotaMb", quotaMb)} hint={t("boxes.quotaHint")}>
                                {(id) => (
                                    <Input id={id} inputMode="numeric" value={quotaMb} onChange={(event) => setQuotaMb(event.target.value.replace(/[^\d]/g, ""))} />
                                )}
                            </Field>
                            <Field label={t("boxes.description")}>
                                {(id) => (
                                    <Input
                                        id={id}
                                        value={description}
                                        onChange={(event) => setDescription(event.target.value)}
                                        placeholder={t("boxes.optional")}
                                    />
                                )}
                            </Field>
                        </div>
                        <label className="flex items-center gap-2 text-[0.8125rem] text-foreground">
                            <Checkbox checked={addToMyMail} onChange={(event) => setAddToMyMail(event.target.checked)} />
                            {t("boxes.addToMyMail")}
                        </label>
                        {error ? <p className="text-xs text-danger">{error}</p> : null}
                        <DialogFooter>
                            <Button type="button" variant="ghost" onClick={close}>
                                {tcommon("actions.cancel")}
                            </Button>
                            <Button type="submit" disabled={!parsed.success || Boolean(refusal) || pending}>
                                {pending ? t("boxes.creating") : t("boxes.create")}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

function EditDialog({
    serverId,
    mailbox,
    domains,
    onClose,
    onSaved
}: {
    serverId: string;
    mailbox: Mailbox | null;
    domains: readonly Domain[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useTranslations("mailServer");
    const tcommon = useTranslations("common");
    const [password, setPassword] = useState("");
    const [quotaMb, setQuotaMb] = useState("");
    const [aliases, setAliases] = useState<{ localPart: string; domainId: string }[]>([]);
    const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
    const [pending, setPending] = useState(false);
    const [seen, setSeen] = useState<string | null>(null);
    const refusal = usePasswordRefusal(password, mailbox?.address ?? "");

    if (mailbox && seen !== mailbox.id) {
        setSeen(mailbox.id);
        setPassword("");
        setQuotaMb(String(mailbox.quotaMb));
        setAliases(mailbox.aliases.map((alias) => ({ localPart: alias.name, domainId: alias.domainId })));
        setMessage(null);
    }

    async function run(action: () => Promise<{ error?: string }>, done: string): Promise<void> {
        setPending(true);
        setMessage(null);
        const answer = await action();
        setPending(false);
        if (answer.error) {
            setMessage({ tone: "error", text: answer.error });
            return;
        }
        setMessage({ tone: "ok", text: done });
        onSaved();
    }

    if (!mailbox) return null;
    const aliasesChanged =
        JSON.stringify(aliases) !== JSON.stringify(mailbox.aliases.map((alias) => ({ localPart: alias.name, domainId: alias.domainId })));
    const quotaChanged = quotaMb !== String(mailbox.quotaMb) && quotaMb !== "";
    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (open) return;
                setSeen(null);
                onClose();
            }}
        >
            <DialogContent className="w-[min(34rem,95vw)] max-w-[min(34rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>{mailbox.address}</DialogTitle>
                    <DialogDescription>{t("boxes.editIntro")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-5">
                    {!mailbox.polaris ? (
                        <Field
                            label={t("boxes.newPassword")}
                            error={mailSchemaText(t, refusal ?? undefined)}
                            hint={t("boxes.newPasswordHint")}
                        >
                            {(id) => (
                                <div className="flex gap-2">
                                    <Input id={id} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
                                    <Button type="button" variant="outline" onClick={() => setPassword(generatedPassword())}>
                                        {t("boxes.generate")}
                                    </Button>
                                    <Button
                                        type="button"
                                        disabled={pending || password.length < 12 || Boolean(refusal)}
                                        onClick={() =>
                                            void run(
                                                () => setMailboxPasswordAction({ serverId, accountId: mailbox.id, password }),
                                                t("boxes.passwordChanged")
                                            )
                                        }
                                    >
                                        {tcommon("actions.save")}
                                    </Button>
                                </div>
                            )}
                        </Field>
                    ) : null}
                    <Field label={t("boxes.quota")} hint={t("boxes.quotaHint")}>
                        {(id) => (
                            <div className="flex gap-2">
                                <Input id={id} inputMode="numeric" value={quotaMb} onChange={(event) => setQuotaMb(event.target.value.replace(/[^\d]/g, ""))} />
                                <Button
                                    type="button"
                                    disabled={pending || !quotaChanged}
                                    onClick={() =>
                                        void run(
                                            () => setMailboxQuotaAction({ serverId, accountId: mailbox.id, quotaMb }),
                                            t("boxes.quotaSaved")
                                        )
                                    }
                                >
                                    {tcommon("actions.save")}
                                </Button>
                            </div>
                        )}
                    </Field>
                    <div className="flex flex-col gap-2">
                        <span className="text-[0.8125rem] font-medium text-foreground">{t("boxes.aliases")}</span>
                        {aliases.map((alias, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <Input
                                    aria-label={t("boxes.aliasName")}
                                    value={alias.localPart}
                                    onChange={(event) =>
                                        setAliases(aliases.map((entry, at) => (at === index ? { ...entry, localPart: event.target.value } : entry)))
                                    }
                                />
                                <div className="w-48 shrink-0">
                                    <Select
                                        aria-label={t("boxes.aliasDomain")}
                                        value={alias.domainId}
                                        onValueChange={(value) =>
                                            setAliases(aliases.map((entry, at) => (at === index ? { ...entry, domainId: value } : entry)))
                                        }
                                        options={domains.map((domain) => ({ value: domain.id, label: `@${domain.name}` }))}
                                    />
                                </div>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("boxes.removeAlias")}
                                    title={t("boxes.removeAlias")}
                                    onClick={() => setAliases(aliases.filter((_, at) => at !== index))}
                                >
                                    <Trash2 />
                                </Button>
                            </div>
                        ))}
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setAliases([...aliases, { localPart: "", domainId: mailbox.domainId }])}
                            >
                                <Plus />
                                {t("boxes.addAlias")}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                disabled={pending || !aliasesChanged || aliases.some((alias) => !alias.localPart.trim())}
                                onClick={() =>
                                    void run(
                                        () =>
                                            setMailboxAliasesAction({
                                                serverId,
                                                accountId: mailbox.id,
                                                aliases: aliases.map((alias) => ({ localPart: alias.localPart.trim(), domainId: alias.domainId }))
                                            }),
                                        t("boxes.aliasesSaved")
                                    )
                                }
                            >
                                {t("boxes.saveAliases")}
                            </Button>
                        </div>
                    </div>
                    {message ? <p className={message.tone === "error" ? "text-xs text-danger" : "text-xs text-success"}>{message.text}</p> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}
