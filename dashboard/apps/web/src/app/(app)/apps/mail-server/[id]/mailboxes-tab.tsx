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
    const identity =
        password && passwordMatchesIdentity(password, [address])
            ? MAILBOX_IDENTITY_PASSWORD_MESSAGE
            : null;

    useEffect(() => {
        setBreached(null);
        if (password.length < 12 || identity) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void passwordIsBreached(password, controller.signal).then((found) => {
                if (!controller.signal.aborted)
                    setBreached(found ? BREACHED_PASSWORD_MESSAGE : null);
            });
        }, 400);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [password, identity]);

    return identity ?? breached;
}

function quotaLabel(quotaMb: number): string {
    if (quotaMb <= 0) return "No limit";
    return quotaMb >= 1024 ? `${Math.round((quotaMb / 1024) * 10) / 10} GB` : `${quotaMb} MB`;
}

export function MailboxesTab({ serverId }: { serverId: string }) {
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
                    New mailbox
                </Button>
            </div>
            {!panel.data ? (
                panel.error ? (
                    <PanelError message={panel.error} onRetry={() => void panel.reload()} />
                ) : (
                    <Skeleton className="h-40 w-full" />
                )
            ) : mailboxes.length === 0 ? (
                <EmptyState
                    icon={<Inbox />}
                    title="No mailboxes yet"
                    description="Create one for each person or address that receives mail."
                />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-[0.8125rem]">
                        <thead>
                            <tr className="text-left">
                                <th className="w-full max-w-0 py-1.5 pr-3">Address</th>
                                <th className="py-1.5 pr-3">Quota</th>
                                <th className="py-1.5 pr-3">Also receives</th>
                                <th className="py-1.5" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {mailboxes.map((mailbox) => (
                                <tr key={mailbox.id}>
                                    <td className="w-full max-w-0 py-2 pr-3">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span
                                                className="truncate text-foreground"
                                                title={mailbox.address}
                                            >
                                                {mailbox.address}
                                            </span>
                                            {mailbox.polaris ? (
                                                <Badge>Polaris sends from this</Badge>
                                            ) : null}
                                        </div>
                                        {mailbox.description ? (
                                            <p
                                                className="truncate text-xs text-muted-foreground"
                                                title={mailbox.description}
                                            >
                                                {mailbox.description}
                                            </p>
                                        ) : null}
                                    </td>
                                    <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">
                                        {quotaLabel(mailbox.quotaMb)}
                                    </td>
                                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                                        {mailbox.aliases.length === 0
                                            ? "-"
                                            : mailbox.aliases
                                                  .map(
                                                      (alias) =>
                                                          `${alias.name}@${domainName.get(alias.domainId) ?? "?"}`
                                                  )
                                                  .join(", ")}
                                    </td>
                                    <td className="whitespace-nowrap py-2 text-right">
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={`Edit ${mailbox.address}`}
                                            title={`Edit ${mailbox.address}`}
                                            onClick={() => setEditing(mailbox)}
                                        >
                                            <Pencil />
                                        </Button>
                                        {!mailbox.polaris ? (
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={`Delete ${mailbox.address}`}
                                                title={`Delete ${mailbox.address}`}
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
            <EditDialog
                serverId={serverId}
                mailbox={editing}
                domains={domains}
                onClose={() => setEditing(null)}
                onSaved={() => void panel.reload()}
            />
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                name={deleting?.address ?? ""}
                kind="mailbox"
                description="Every message in it is deleted with it, and mail to the address starts bouncing."
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
    const input = {
        serverId,
        domainId: chosenDomain,
        localPart,
        password,
        quotaMb: quotaMb || "0",
        description,
        addToMyMail
    };
    const parsed = mailboxCreateSchema.safeParse(input);
    const address = `${localPart.trim().toLowerCase()}@${domains.find((domain) => domain.id === chosenDomain)?.name ?? ""}`;
    const refusal = usePasswordRefusal(password, address);
    const issue = (path: string, value: string): string | null =>
        parsed.success || !value.trim()
            ? null
            : (parsed.error.issues.find((entry) => entry.path[0] === path)?.message ?? null);

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
                    <DialogTitle>{done ? "Mailbox created" : "New mailbox"}</DialogTitle>
                    <DialogDescription>
                        {done
                            ? done.address
                            : "Mail apps sign in with the address and this password over IMAP 993 and SMTP 465."}
                    </DialogDescription>
                </DialogHeader>
                {done ? (
                    <div className="flex flex-col gap-3 text-[0.8125rem]">
                        {done.warning ? (
                            <p className="text-warning">{done.warning}</p>
                        ) : addToMyMail ? (
                            <p className="text-muted-foreground">It is in your Mail as well.</p>
                        ) : null}
                        <DialogFooter>
                            <Button type="button" onClick={close}>
                                Done
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
                            <Field label="Name" required error={issue("localPart", localPart)}>
                                {(id) => (
                                    <Input
                                        id={id}
                                        value={localPart}
                                        onChange={(event) => setLocalPart(event.target.value)}
                                        placeholder="alice"
                                    />
                                )}
                            </Field>
                            <Field label="Domain" required>
                                {(id) => (
                                    <Select
                                        id={id}
                                        value={chosenDomain}
                                        onValueChange={setDomainId}
                                        options={domains.map((domain) => ({
                                            value: domain.id,
                                            label: `@${domain.name}`
                                        }))}
                                    />
                                )}
                            </Field>
                        </div>
                        <Field
                            label="Password"
                            required
                            error={issue("password", password) ?? refusal}
                            hint="At least 12 characters."
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
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => setPassword(generatedPassword())}
                                    >
                                        Generate
                                    </Button>
                                </div>
                            )}
                        </Field>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field
                                label="Quota in MB"
                                error={issue("quotaMb", quotaMb)}
                                hint="0 for no limit."
                            >
                                {(id) => (
                                    <Input
                                        id={id}
                                        inputMode="numeric"
                                        value={quotaMb}
                                        onChange={(event) =>
                                            setQuotaMb(event.target.value.replace(/[^\d]/g, ""))
                                        }
                                    />
                                )}
                            </Field>
                            <Field label="Description">
                                {(id) => (
                                    <Input
                                        id={id}
                                        value={description}
                                        onChange={(event) => setDescription(event.target.value)}
                                        placeholder="Optional"
                                    />
                                )}
                            </Field>
                        </div>
                        <label className="flex items-center gap-2 text-[0.8125rem] text-foreground">
                            <Checkbox
                                checked={addToMyMail}
                                onChange={(event) => setAddToMyMail(event.target.checked)}
                            />
                            Add it to my Mail
                        </label>
                        {error ? <p className="text-xs text-danger">{error}</p> : null}
                        <DialogFooter>
                            <Button type="button" variant="ghost" onClick={close}>
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={!parsed.success || Boolean(refusal) || pending}
                            >
                                {pending ? "Creating..." : "Create"}
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
        setAliases(
            mailbox.aliases.map((alias) => ({ localPart: alias.name, domainId: alias.domainId }))
        );
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
        JSON.stringify(aliases) !==
        JSON.stringify(
            mailbox.aliases.map((alias) => ({ localPart: alias.name, domainId: alias.domainId }))
        );
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
                    <DialogDescription>Each part saves on its own.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-5">
                    {!mailbox.polaris ? (
                        <Field
                            label="New password"
                            error={refusal}
                            hint="Mail apps signed in with the old one are asked for this one."
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
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => setPassword(generatedPassword())}
                                    >
                                        Generate
                                    </Button>
                                    <Button
                                        type="button"
                                        disabled={
                                            pending || password.length < 12 || Boolean(refusal)
                                        }
                                        onClick={() =>
                                            void run(
                                                () =>
                                                    setMailboxPasswordAction({
                                                        serverId,
                                                        accountId: mailbox.id,
                                                        password
                                                    }),
                                                "Password changed."
                                            )
                                        }
                                    >
                                        Save
                                    </Button>
                                </div>
                            )}
                        </Field>
                    ) : null}
                    <Field label="Quota in MB" hint="0 for no limit.">
                        {(id) => (
                            <div className="flex gap-2">
                                <Input
                                    id={id}
                                    inputMode="numeric"
                                    value={quotaMb}
                                    onChange={(event) =>
                                        setQuotaMb(event.target.value.replace(/[^\d]/g, ""))
                                    }
                                />
                                <Button
                                    type="button"
                                    disabled={pending || !quotaChanged}
                                    onClick={() =>
                                        void run(
                                            () =>
                                                setMailboxQuotaAction({
                                                    serverId,
                                                    accountId: mailbox.id,
                                                    quotaMb
                                                }),
                                            "Quota saved."
                                        )
                                    }
                                >
                                    Save
                                </Button>
                            </div>
                        )}
                    </Field>
                    <div className="flex flex-col gap-2">
                        <span className="text-[0.8125rem] font-medium text-foreground">
                            Other addresses that deliver here
                        </span>
                        {aliases.map((alias, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <Input
                                    aria-label="Alias name"
                                    value={alias.localPart}
                                    onChange={(event) =>
                                        setAliases(
                                            aliases.map((entry, at) =>
                                                at === index
                                                    ? { ...entry, localPart: event.target.value }
                                                    : entry
                                            )
                                        )
                                    }
                                />
                                <div className="w-48 shrink-0">
                                    <Select
                                        aria-label="Alias domain"
                                        value={alias.domainId}
                                        onValueChange={(value) =>
                                            setAliases(
                                                aliases.map((entry, at) =>
                                                    at === index
                                                        ? { ...entry, domainId: value }
                                                        : entry
                                                )
                                            )
                                        }
                                        options={domains.map((domain) => ({
                                            value: domain.id,
                                            label: `@${domain.name}`
                                        }))}
                                    />
                                </div>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    aria-label="Remove this alias"
                                    title="Remove this alias"
                                    onClick={() =>
                                        setAliases(aliases.filter((_, at) => at !== index))
                                    }
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
                                onClick={() =>
                                    setAliases([
                                        ...aliases,
                                        { localPart: "", domainId: mailbox.domainId }
                                    ])
                                }
                            >
                                <Plus />
                                Add an address
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                disabled={
                                    pending ||
                                    !aliasesChanged ||
                                    aliases.some((alias) => !alias.localPart.trim())
                                }
                                onClick={() =>
                                    void run(
                                        () =>
                                            setMailboxAliasesAction({
                                                serverId,
                                                accountId: mailbox.id,
                                                aliases: aliases.map((alias) => ({
                                                    localPart: alias.localPart.trim(),
                                                    domainId: alias.domainId
                                                }))
                                            }),
                                        "Addresses saved."
                                    )
                                }
                            >
                                Save addresses
                            </Button>
                        </div>
                    </div>
                    {message ? (
                        <p
                            className={
                                message.tone === "error"
                                    ? "text-xs text-danger"
                                    : "text-xs text-success"
                            }
                        >
                            {message.text}
                        </p>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}
