"use client";

/**
 * Connecting a mailbox.
 *
 * The flow is one field long for nearly everybody: type the address, and Polaris
 * works out where its mail lives. What happens next depends only on what it
 * found.
 *
 * - **A service that can be authorized** (Gmail, Outlook): a Connect button, and
 *   no password is ever typed. If the account is already linked here for
 *   something else, it is offered directly.
 * - **A service that needs a password**: one password field, with the sentence
 *   that service's own support page would have said - "Google refuses your
 *   ordinary password here", "Yahoo needs an app password" - because that is the
 *   single most common reason a correct password is refused.
 * - **Anything else**: the servers Polaris found, filled in and editable. The
 *   fields are shown rather than hidden behind "advanced": somebody who got here
 *   is somebody whose domain answered nothing, and hiding the fields from them
 *   would be hiding the only thing left to try.
 *
 * Nothing is stored until both servers have accepted the credential, so a
 * mistyped password fails on this form rather than as a mailbox that silently
 * never syncs.
 */

import Link from "next/link";
import { SendCheck } from "./send-check";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { MAIL_TRASH_KEEP_CHOICES } from "@polaris/core";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { mailRefusalText } from "@/lib/mailbox/refusal-text";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { setWorkspaceScopeAction } from "@/app/(app)/scope-actions";
import { Button, ConfirmDeleteDialog, Select, Switch, cn, useToast } from "@polaris/ui";
import { ConnectMailboxDialog, type LinkedAccount } from "@/app/(app)/mail/connect-dialog";
import { AlertTriangle, CheckCircle2, Mail, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
    editAccountAction,
    removeAccountAction,
    syncAccountAction
} from "@/app/(app)/mail/actions";

export function AccountsView({
    accounts,
    links,
    googleReady,
    publicAddress,
    canSetDomain,
    microsoftReady,
    outcome,
    outcomeProvider,
    connectNow = false,
    editNow = "",
    moveShelf = null
}: {
    accounts: MailAccountView[];
    links: LinkedAccount[];
    googleReady: boolean;
    publicAddress: boolean;
    canSetDomain: boolean;
    microsoftReady: boolean;
    outcome: string;
    outcomeProvider: string;
    /** Open the connect dialog straight away. */
    connectNow?: boolean;
    /**
     * Open one mailbox's edit form straight away - where the notice that a
     * mailbox stopped accepting its password sends somebody. A refused mailbox
     * opens on its password box, because that is the field they came to fill.
     */
    editNow?: string;
    /**
     * The shelf the mailbox `editNow` names is on, when the header is on a
     * different one. The list is already that shelf's; the header is moved to
     * match, so the two do not disagree about which mailboxes these are.
     */
    moveShelf?: string | null;
}) {
    const router = useRouter();
    const t = useTranslations("mailSettings");
    const movedTo = useRef<string | null>(null);
    useEffect(() => {
        if (!moveShelf) {
            movedTo.current = null;
            return;
        }
        if (movedTo.current === moveShelf) return;
        movedTo.current = moveShelf;
        // The action revalidates every layout and answers with the new render,
        // which the router applies; refreshing after it drew the whole frame a
        // second time while the reader waited.
        void setWorkspaceScopeAction(moveShelf).catch(() => undefined);
    }, [moveShelf]);
    const [adding, setAdding] = useState(connectNow);
    const [editing, setEditing] = useState<{ id: string; focusPassword: boolean } | null>(() => {
        const asked = accounts.find((account) => account.id === editNow);
        return asked ? { id: asked.id, focusPassword: asked.state === "auth" } : null;
    });
    // The same, for a notice pressed while this screen is already open: the
    // address changes and the view stays mounted. Once per `?edit=`, so the
    // refresh that follows a save does not open the form it just closed.
    const openedFor = useRef(editNow);
    useEffect(() => {
        if (!editNow) {
            openedFor.current = "";
            return;
        }
        if (openedFor.current === editNow) return;
        const asked = accounts.find((account) => account.id === editNow);
        if (!asked) return;
        openedFor.current = editNow;
        setEditing({ id: asked.id, focusPassword: asked.state === "auth" });
    }, [editNow, accounts]);
    /**
     * What a row says while its edit is with the servers: the new name at once,
     * and "checking" where a credential is being tried. Dropped when the
     * server's own list arrives, or taken back by the dialog on a refusal.
     */
    const [pending, setPending] = useState<Record<string, Partial<MailAccountView>>>({});
    useEffect(() => setPending({}), [accounts]);
    /** Mailboxes removed here, gone from the list before the server's own list
     *  comes back without them. */
    const [removed, setRemoved] = useState<string[]>([]);
    useEffect(() => setRemoved([]), [accounts]);

    const shown = accounts
        .filter((account) => !removed.includes(account.id))
        .map((account) => ({ ...account, ...pending[account.id] }));
    const editedAccount = editing ? accounts.find((account) => account.id === editing.id) : undefined;

    function closeEditor(): void {
        setEditing(null);
        // Arrived with `?edit=`: leaving it on the address would open the form
        // again on the next refresh, which is every save.
        if (editNow) router.replace("/mail/settings/accounts", { scroll: false });
    }

    return (
        <div className="space-y-4">
            {outcome === "linked" ? (
                <p className="rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
                    {t("accounts.linked", { provider: outcomeProvider === "microsoft" ? "Microsoft" : "Google" })}
                </p>
            ) : null}
            {outcome === "not_public" ? (
                <p className="rounded-md border border-danger-edge bg-card px-3 py-2 text-[13px] text-danger">
                    {t("accounts.notPublic", { provider: outcomeProvider === "microsoft" ? "Microsoft" : "Google" })}{" "}
                    {canSetDomain ? (
                        <Link href="/admin/domains" className="underline">
                            {t("accounts.givePublic")}
                        </Link>
                    ) : (
                        t("accounts.askAdmin")
                    )}
                </p>
            ) : outcome === "wrong_account" ? (
                <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-[13px]">
                    {t("accounts.wrongAccount", { provider: outcomeProvider === "microsoft" ? "Microsoft" : "Google" })}
                </p>
            ) : outcome && outcome !== "linked" ? (
                <p className="rounded-md border border-danger-edge bg-card px-3 py-2 text-[13px] text-danger">
                    {t("accounts.unfinished")}
                </p>
            ) : null}

            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-[15px] font-semibold tracking-tight">{t("accounts.title")}</h2>
                    <p className="text-[13px] text-muted-foreground">{t("accounts.lead")}</p>
                </div>
                <Button onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("accounts.add")}
                </Button>
            </div>

            {accounts.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
                    <Mail className="mx-auto size-5 shrink-0 text-foreground-subtle" aria-hidden />
                    <p className="mt-2 text-[13px] font-medium">{t("noMailboxes.title")}</p>
                    <p className="mt-1 text-[13px] text-muted-foreground">{t("accounts.emptyBody")}</p>
                </div>
            ) : (
                <ul className="space-y-2">
                    {shown.map((account) => (
                        <AccountRow
                            key={account.id}
                            account={account}
                            onEdit={(focusPassword) => setEditing({ id: account.id, focusPassword })}
                            onRemoved={(gone) =>
                                setRemoved((held) =>
                                    gone
                                        ? [...held, account.id]
                                        : held.filter((id) => id !== account.id)
                                )
                            }
                        />
                    ))}
                </ul>
            )}

            {editedAccount ? (
                <ConnectMailboxDialog
                    // One form per mailbox: opening another starts from its own
                    // values rather than the last one's.
                    key={editedAccount.id}
                    editing={editedAccount}
                    focusPassword={editing?.focusPassword ?? false}
                    title={t("accounts.editTitle")}
                    links={links}
                    googleReady={googleReady}
                    microsoftReady={microsoftReady}
                    publicAddress={publicAddress}
                    canSetDomain={canSetDomain}
                    onPending={(next) =>
                        setPending((held) => {
                            const rest = { ...held };
                            delete rest[editedAccount.id];
                            return next ? { ...rest, [editedAccount.id]: next } : rest;
                        })
                    }
                    onClose={closeEditor}
                />
            ) : null}

            {adding ? (
                <ConnectMailboxDialog
                    links={links}
                    googleReady={googleReady}
                    microsoftReady={microsoftReady}
                    publicAddress={publicAddress}
                    canSetDomain={canSetDomain}
                    // What this screen is a list of. The dialog can answer
                    // "you already have that one" while it is being typed
                    // rather than after a lookup and a password.
                    taken={accounts.map((account) => account.address)}
                    onClose={() => setAdding(false)}
                />
            ) : null}
        </div>
    );
}

function AccountRow({
    account,
    onEdit,
    onRemoved
}: {
    account: MailAccountView;
    /** Open the edit form, on the password box when that is what is wrong. */
    onEdit: (focusPassword: boolean) => void;
    /** Taken off the list now, and put back when the server refuses: removing a
     *  mailbox is a write and a revalidation, and a row that sits there until
     *  both land reads as the press having done nothing. */
    onRemoved: (gone: boolean) => void;
}) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const tm = useTranslations("mail");
    const [busy, startBusy] = useBusy();
    const [removing, setRemoving] = useState(false);
    const [unified, setUnified] = useState(account.unified);
    const [notify, setNotify] = useState(account.notify);
    const [trashDays, setTrashDays] = useState(account.trashKeepDays);

    const refused = account.state === "auth";
    const broken = refused || account.state === "unreachable";

    return (
        <li className="rounded-md border border-border bg-card px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13px] font-medium">
                        {account.color ? (
                            <span
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: account.color }}
                                aria-hidden
                            />
                        ) : null}
                        <span className="min-w-0 truncate" title={account.label || account.address}>
                            {account.label || account.address}
                        </span>
                        {account.serviceName ? (
                            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                {account.serviceName}
                            </span>
                        ) : null}
                        {account.auth === "oauth" ? (
                            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                {t("accounts.authorized")}
                            </span>
                        ) : null}
                    </p>
                    <p
                        className="truncate text-[12px] text-muted-foreground"
                        title={account.address}
                    >
                        {account.address}
                    </p>
                    <p
                        className={cn(
                            "mt-0.5 flex items-center gap-1.5 text-[12px]",
                            broken ? "text-danger" : "text-foreground-subtle"
                        )}
                    >
                        {broken ? (
                            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                        ) : account.state === "checking" ? (
                            <RefreshCw className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        ) : (
                            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
                        )}
                        {stateSentence(t, tm, account)}
                    </p>
                </div>

                {refused ? (
                    <Button size="sm" variant="outline" onClick={() => onEdit(true)}>
                        {account.auth === "oauth" ? tm("refused.reconnect") : tm("refused.updatePassword")}
                    </Button>
                ) : null}

                <label className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
                    <Switch
                        checked={unified}
                        onChange={(next) => {
                            setUnified(next);
                            startBusy(async () => {
                                // Only this switch. The edit is a patch, so the
                                // rest of the mailbox's settings are left alone.
                                const answer = await editAccountAction(account.id, {
                                    unified: next
                                });
                                const said = refusalOf(answer);
                                if (said) {
                                    setUnified(!next);
                                    toast.show({ title: said });
                                    return;
                                }
                                router.refresh();
                            });
                        }}
                        aria-label={t("accounts.unifiedLabel")}
                    />
                    {t("accounts.unified")}
                </label>

                <label
                    className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground"
                    title={t("accounts.notifyHint")}
                >
                    <Switch
                        checked={notify}
                        onChange={(next) => {
                            setNotify(next);
                            startBusy(async () => {
                                const answer = await editAccountAction(account.id, { notify: next });
                                const said = refusalOf(answer);
                                if (said) {
                                    setNotify(!next);
                                    toast.show({ title: said });
                                    return;
                                }
                                router.refresh();
                            });
                        }}
                        aria-label={t("accounts.notifyLabel")}
                    />
                    {t("accounts.notify")}
                </label>

                {/* What every mail service does, said where the mailbox's own
                    switches are. The default is thirty days; "until I empty it"
                    is what Polaris did before this existed and is still an
                    answer somebody can give. */}
                <label
                    className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground"
                    title={t("accounts.trashHint")}
                >
                    {t("accounts.trash")}
                    <Select
                        value={String(trashDays)}
                        aria-label={t("accounts.trashLabel")}
                        className="h-7 w-44 text-[12px]"
                        options={MAIL_TRASH_KEEP_CHOICES.map((choice) => ({
                            value: String(choice.days),
                            label: t("accounts.trashKeep", { days: choice.days })
                        }))}
                        onValueChange={(next) => {
                            const days = Number(next);
                            const before = trashDays;
                            setTrashDays(days);
                            startBusy(async () => {
                                const answer = await editAccountAction(account.id, {
                                    trashKeepDays: days
                                });
                                const said = refusalOf(answer);
                                if (said) {
                                    setTrashDays(before);
                                    toast.show({ title: said });
                                    return;
                                }
                                router.refresh();
                            });
                        }}
                    />
                </label>

                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("accounts.checkNow")}
                    title={t("accounts.checkNow")}
                    disabled={busy}
                    onClick={() =>
                        startBusy(async () => {
                            const answer = await syncAccountAction(account.id);
                            const said = refusalOf(answer);
                            if (said) toast.show({ title: said });
                            router.refresh();
                        })
                    }
                >
                    <RefreshCw
                        className={cn("size-4 shrink-0", busy && "animate-spin")}
                        aria-hidden
                    />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("accounts.edit")}
                    title={t("accounts.edit")}
                    onClick={() => onEdit(false)}
                >
                    <Pencil className="size-4 shrink-0" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("accounts.remove")}
                    title={t("accounts.remove")}
                    onClick={() => setRemoving(true)}
                >
                    <Trash2 className="size-4 shrink-0" aria-hidden />
                </Button>
            </div>

            {/* Not for a mailbox whose credential is already refused: it would
                send a message that cannot be sent and report the refusal the
                line above already states. */}
            {refused ? null : <SendCheck accountId={account.id} />}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(next) => setRemoving(next)}
                    name={account.address}
                    kind="mailbox"
                    // One row of several and nothing inside it is lost, so a
                    // plain confirmation rather than typing the address out.
                    requireTyping={false}
                    title={t("accounts.removeTitle", { address: account.address })}
                    // Both halves, because each is a thing somebody gets wrong
                    // in the opposite direction: "remove mailbox" reads as
                    // "delete my mail" to anybody who has not thought about
                    // where mail lives, and it reads as "only stop checking it"
                    // to anybody who has - while the filters they wrote here,
                    // and everything else Polaris holds for this mailbox alone,
                    // go with it.
                    question={t.rich("accounts.removeQuestion", {
                        address: account.address,
                        strong: (chunks) => <span key="name" className="font-medium text-foreground">{chunks}</span>
                    })}
                    description={t("accounts.removeBody", { oauth: account.auth === "oauth" ? "yes" : "no" })}
                    confirmLabel={t("accounts.removeConfirm")}
                    onConfirm={() => {
                        setRemoving(false);
                        onRemoved(true);
                        void (async () => {
                            const answer = await removeAccountAction(account.id);
                            const said = refusalOf(answer);
                            if (said) {
                                onRemoved(false);
                                toast.show({ title: said });
                                return;
                            }
                            toast.show({ title: t("accounts.removed", { address: account.address }) });
                            router.refresh();
                        })();
                    }}
                />
            ) : null}
        </li>
    );
}

function stateSentence(
    t: NamespaceTranslator<"mailSettings">,
    tm: NamespaceTranslator<"mail">,
    account: MailAccountView
): string {
    if (account.state === "checking") return t("accounts.state.checking");
    if (account.state === "auth") {
        // Said as what happened and what Polaris did about it. The detail is
        // the refusal's own sentence, which is Polaris' words, never the
        // server's.
        return account.auth === "oauth"
            ? t("accounts.state.oauthRefused", {
                  detail: account.stateDetail ? mailRefusalText(tm, account.stateDetail) : t("accounts.state.oauthDefault")
              })
            : t("accounts.state.passwordRefused", {
                  detail: account.stateDetail ? mailRefusalText(tm, account.stateDetail) : t("accounts.state.passwordDefault")
              });
    }
    if (account.state === "unreachable") return tm("rail.unreachable");
    if (account.state === "never") return t("accounts.state.never");
    return account.lastSyncAt ? t("accounts.state.recent") : t("accounts.state.connected");
}
