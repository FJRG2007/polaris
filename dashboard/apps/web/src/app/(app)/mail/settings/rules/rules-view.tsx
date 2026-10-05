"use client";

/**
 * Filters, per mailbox.
 *
 * Each filter is an automation - WHEN a message arrives, IF these hold, THEN
 * these steps - opened in the same editor Places' automations use. The list
 * reads each one back as a sentence ("If the subject contains 'PR run failed:',
 * put it in the trash."), because a filter is something people write once and
 * read back a year later trying to work out why a message vanished.
 *
 * The order matters and the screen says so, because a filter that stops the
 * ones below it is the single most confusing thing about every filter system
 * ever built. Every change here - switching one off, moving it, copying it,
 * deleting it, saving it - shows at once and is put back if the server refuses.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, MoreHorizontal, Pencil, Play, Plus, Trash2 } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Switch,
    useToast
} from "@polaris/ui";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { useConfirm } from "@/components/confirm-dialog";
import type { MailRuleView } from "@/lib/mailbox/rules";
import type { MailLabelView } from "@/lib/mailbox/labels";
import type { MailFolderView } from "@/lib/mailbox/views";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    deleteRuleAction,
    duplicateRuleAction,
    reorderRulesAction,
    runRuleOverInboxAction,
    saveRuleAction,
    setRuleEnabledAction
} from "@/app/(app)/mail/actions";
import { FilterEditor, Saving, draftOf, type FilterDraft, type FilterIssue } from "./filter-editor";
import * as words from "./filter-words";

/** What "Filter messages like this" asked for, from the address that opened
 *  this screen - read once, when it opens. */
export interface RuleSeed {
    readonly accountId: string | null;
    readonly from: string;
    readonly similar: string;
}

export function seedFrom(params: URLSearchParams | null): RuleSeed | null {
    if (!params) return null;
    const from = (params.get("from") ?? "").trim().slice(0, 320);
    const similar = (params.get("similar") ?? "").trim().slice(0, 500);
    if (!from && !similar) return null;
    return { accountId: params.get("account"), from, similar };
}

/** What the editor is open on: a filter by id, or a new one. A refused save
 *  reopens it on the draft that was refused, with what the server said. */
type Editing = {
    readonly id: string | null;
    readonly draft: FilterDraft;
    readonly issues: readonly FilterIssue[];
    readonly error: string;
};

/** A row on its way to the server. */
type Pending = MailRuleView & { readonly saving?: boolean };

export function RulesView({
    accounts,
    folders,
    labels,
    rules,
    forwardTargets
}: {
    accounts: MailAccountView[];
    folders: MailFolderView[];
    labels: MailLabelView[];
    rules: Record<string, MailRuleView[]>;
    forwardTargets: string[];
}) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const [confirm, confirmDialog] = useConfirm();
    // Opened from "Filter messages like this": the editor starts open on that
    // mailbox, filled in from the message.
    const params = useSearchParams();
    const [seed] = useState(() => seedFrom(params ? new URLSearchParams(params.toString()) : null));
    const [accountId, setAccountId] = useState(
        seed?.accountId && accounts.some((one) => one.id === seed.accountId)
            ? seed.accountId
            : accounts[0]!.id
    );
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;

    // The list as this screen believes it, ahead of the server where a change is
    // on its way. Replaced by what the server says whenever it says something.
    const [byAccount, setByAccount] = useState<Record<string, Pending[]>>(rules);
    useEffect(() => setByAccount(rules), [rules]);
    const mine = byAccount[account.id] ?? [];
    const setMine = (change: (current: Pending[]) => Pending[]) =>
        setByAccount((current) => ({
            ...current,
            [account.id]: change(current[account.id] ?? [])
        }));
    /** Put a mailbox's list back the way it was, after a refusal. */
    const restore = (accountKey: string, before: Pending[]) =>
        setByAccount((current) => ({ ...current, [accountKey]: before }));

    const [editing, setEditing] = useState<Editing | null>(() =>
        seed
            ? {
                  id: null,
                  draft: {
                      name: seed.similar
                          ? t("rules.likeName", { subject: seed.similar }).slice(0, 80)
                          : "",
                      enabled: true,
                      definition: words.blankDefinition(seed),
                      applyToExisting: false
                  },
                  issues: [],
                  error: ""
              }
            : null
    );
    const busy = useRef(new Set<string>());

    const myFolders = folders.filter((folder) => folder.accountId === account.id);
    const lookup: words.FilterLookup = {
        folderName: (id) => myFolders.find((folder) => folder.id === id)?.name,
        labelName: (id) => labels.find((label) => label.id === id)?.name
    };

    /** A run over the inbox leaves forwards out, which the toast says when the
     *  filter has one. */
    const notForwarded = (definition: core.MailFilterDefinition) =>
        definition.actions.some((step) => step.kind === "forward")
            ? ` ${t("rules.list.notForwarded")}`
            : "";

    /** A row the server has taken: its own id from now on, and no spinner. The
     *  refresh that follows brings the server's copy, but the row must not wait
     *  on it to stop saying it is saving. */
    const landed = (accountKey: string, shownAs: string, answer: unknown) => {
        const held =
            typeof answer === "object" && answer !== null && "id" in answer ? answer.id : undefined;
        const id = typeof held === "string" ? held : shownAs;
        setByAccount((current) => ({
            ...current,
            [accountKey]: (current[accountKey] ?? []).map((row) =>
                row.id === shownAs ? { ...row, id, saving: false } : row
            )
        }));
    };

    /** Say a refusal, put the list back, and ask the server for the truth. */
    const refused = (said: string, accountKey: string, before: Pending[]) => {
        restore(accountKey, before);
        toast.show({ title: said });
        router.refresh();
    };

    const save = (id: string | null, draft: FilterDraft) => {
        const accountKey = account.id;
        const before = mine;
        const definition = draft.definition;
        // Shown at once - in place, or at the bottom for a new one - and put back
        // if the server refuses it, with the editor reopened on what was refused.
        const temporary = id ?? `new-${core.automationNodeId()}`;
        setMine((current) =>
            id
                ? current.map((row) =>
                      row.id === id
                          ? {
                                ...row,
                                name: draft.name,
                                enabled: draft.enabled,
                                definition,
                                saving: true
                            }
                          : row
                  )
                : [
                      ...current,
                      {
                          id: temporary,
                          name: draft.name,
                          enabled: draft.enabled,
                          definition,
                          position: current.length,
                          matchCount: 0,
                          lastRunAt: null,
                          saving: true
                      }
                  ]
        );
        setEditing(null);
        void (async () => {
            const answer = await saveRuleAction(accountKey, id, draft).catch(() => ({
                error: t("rules.list.unreachable")
            }));
            const said = refusalOf(answer);
            if (said) {
                restore(accountKey, before);
                const issues =
                    "issues" in answer && Array.isArray(answer.issues)
                        ? (answer.issues as FilterIssue[])
                        : [];
                setEditing({ id, draft, issues, error: said });
                return;
            }
            landed(accountKey, temporary, answer);
            // Saved switched on, it was applied to the inbox: say to how many,
            // or that it is still going on a big one.
            const applied =
                typeof answer === "object" && answer !== null && "applied" in answer
                    ? answer.applied
                    : null;
            toast.show({
                title: !draft.enabled
                    ? t("rules.saved")
                    : typeof applied === "number"
                      ? `${t("rules.list.savedApplied", { count: applied })}${notForwarded(definition)}`
                      : `${t("rules.list.savedRunning")}${notForwarded(definition)}`
            });
            router.refresh();
        })();
    };

    /** One change to a row, shown at once and undone if refused. */
    const change = (
        key: string,
        optimistic: (current: Pending[]) => Pending[],
        call: () => Promise<unknown>,
        done?: string,
        /** The row shown ahead of the server, when the change adds one. */
        shownAs?: string
    ) => {
        if (busy.current.has(key)) return;
        busy.current.add(key);
        const accountKey = account.id;
        const before = mine;
        setMine(optimistic);
        void (async () => {
            const answer = await call().catch(() => ({ error: t("rules.list.unreachable") }));
            busy.current.delete(key);
            const said = refusalOf(answer);
            if (said) {
                refused(said, accountKey, before);
                return;
            }
            if (shownAs) landed(accountKey, shownAs, answer);
            if (done) toast.show({ title: done });
            router.refresh();
        })();
    };

    const toggle = (rule: Pending, enabled: boolean) =>
        change(
            `toggle-${rule.id}`,
            (current) => current.map((row) => (row.id === rule.id ? { ...row, enabled } : row)),
            () => setRuleEnabledAction(account.id, rule.id, enabled)
        );

    const move = (index: number, by: -1 | 1) => {
        const target = index + by;
        if (target < 0 || target >= mine.length) return;
        const next = [...mine];
        [next[index], next[target]] = [next[target]!, next[index]!];
        change(
            "order",
            () => next,
            () =>
                reorderRulesAction(
                    account.id,
                    next.map((row) => row.id)
                )
        );
    };

    const duplicate = (rule: Pending, index: number) => {
        const name = t("rules.list.copyName", { name: rule.name }).slice(0, 80);
        change(
            `copy-${rule.id}`,
            (current) => [
                ...current.slice(0, index + 1),
                {
                    ...rule,
                    id: `copy-${rule.id}`,
                    name,
                    enabled: false,
                    matchCount: 0,
                    lastRunAt: null,
                    saving: true
                },
                ...current.slice(index + 1)
            ],
            () => duplicateRuleAction(account.id, rule.id, name),
            t("rules.list.copied"),
            `copy-${rule.id}`
        );
    };

    const remove = async (rule: Pending) => {
        const sure = await confirm({
            title: t("rules.list.deleteTitle", { name: rule.name }),
            description: t("rules.list.deleteBody"),
            confirmLabel: t("rules.list.delete"),
            danger: true
        });
        if (!sure) return;
        change(
            `delete-${rule.id}`,
            (current) => current.filter((row) => row.id !== rule.id),
            () => deleteRuleAction(account.id, rule.id),
            t("rules.list.deleted")
        );
    };

    const run = (rule: Pending) =>
        change(
            `run-${rule.id}`,
            (current) => current,
            () => runRuleOverInboxAction(account.id, rule.id),
            `${t("rules.list.running", { name: rule.name })}${notForwarded(rule.definition)}`
        );

    if (editing) {
        const existing = editing.id ? mine.find((row) => row.id === editing.id) : undefined;
        return (
            <div className="min-w-0">
                {confirmDialog}
                <FilterEditor
                    key={`${account.id}-${editing.id ?? "new"}-${editing.error}`}
                    initial={editing.draft}
                    isNew={editing.id === null || existing === undefined || editing.error !== ""}
                    folders={myFolders}
                    labels={labels}
                    forwardTargets={forwardTargets}
                    mailboxAddresses={accounts.map((one) => one.address)}
                    serverIssues={editing.issues}
                    serverError={editing.error}
                    onSave={(draft) => save(editing.id, draft)}
                    onClose={() => setEditing(null)}
                />
            </div>
        );
    }

    const open = (rule: Pending) => {
        if (rule.saving) return;
        setEditing({ id: rule.id, draft: draftOf(rule), issues: [], error: "" });
    };

    return (
        <div className="min-w-0">
            {confirmDialog}
            <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />

            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <h2 className="break-words text-[13px] font-medium [overflow-wrap:anywhere]">
                        {t("rules.title", { address: account.address })}
                    </h2>
                    <p className="text-[12px] text-muted-foreground">{t("rules.hint")}</p>
                </div>
                <Button
                    variant="secondary"
                    disabled={mine.length >= core.MAIL_FILTER_LIMITS.filters}
                    title={
                        mine.length >= core.MAIL_FILTER_LIMITS.filters
                            ? t("rules.list.full")
                            : undefined
                    }
                    onClick={() =>
                        setEditing({
                            id: null,
                            draft: {
                                name: "",
                                enabled: true,
                                definition: words.blankDefinition(),
                                applyToExisting: false
                            },
                            issues: [],
                            error: ""
                        })
                    }
                >
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("rules.new")}
                </Button>
            </div>

            {mine.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
                    {t("rules.empty")}
                </p>
            ) : null}

            <ol className="space-y-2">
                {mine.map((rule, index) => {
                    const stops = core.mailFilterStops(rule.definition);
                    const sentence = words.describeFilter(rule.definition, lookup, t);
                    // Forwards are only sent to a verified address, so one that is
                    // not verified (any more) is a step that does nothing.
                    const unverified = rule.definition.actions.flatMap((step) =>
                        step.kind === "forward" &&
                        !forwardTargets.some((one) => core.sameAddress(one, step.to))
                            ? [step.to]
                            : []
                    );
                    return (
                        <li
                            key={rule.id}
                            className="rounded-md border border-border bg-card px-3 py-2"
                        >
                            <div className="flex min-w-0 items-start gap-2">
                                <span className="mt-0.5 w-5 shrink-0 text-right text-[11px] tabular-nums text-foreground-subtle">
                                    {index + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <button
                                        type="button"
                                        className="flex max-w-full items-center gap-1.5 text-left text-[13px] font-medium hover:underline disabled:no-underline"
                                        disabled={rule.saving}
                                        title={t("rules.list.editNamed", { name: rule.name })}
                                        onClick={() => open(rule)}
                                    >
                                        <span className="min-w-0 truncate">{rule.name}</span>
                                        {rule.saving ? <Saving /> : null}
                                    </button>
                                    <p className="break-words text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
                                        {sentence}
                                    </p>
                                    <p className="text-[11px] text-foreground-subtle">
                                        {rule.enabled ? t("rules.on") : t("rules.off")}
                                        {stops ? t("rules.stops") : ""}
                                        {rule.matchCount > 0
                                            ? t("rules.matched", { count: rule.matchCount })
                                            : ""}
                                    </p>
                                    {unverified.length > 0 ? (
                                        <p className="break-words text-[11px] text-warning [overflow-wrap:anywhere]">
                                            {t("rules.list.unverified", {
                                                to: unverified.join(", ")
                                            })}{" "}
                                            <Link
                                                href="/account/details"
                                                className="underline underline-offset-2 hover:text-foreground"
                                            >
                                                {t("rules.editor.verifyAddress")}
                                            </Link>
                                        </p>
                                    ) : null}
                                </div>
                                <div className="flex shrink-0 items-center gap-0.5">
                                    <Switch
                                        checked={rule.enabled}
                                        disabled={rule.saving}
                                        aria-label={t("rules.list.enabledNamed", {
                                            name: rule.name
                                        })}
                                        onChange={(enabled) => toggle(rule, enabled)}
                                    />
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="hidden sm:inline-flex"
                                        disabled={index === 0 || rule.saving}
                                        aria-label={t("rules.list.upNamed", { name: rule.name })}
                                        title={t("rules.list.upNamed", { name: rule.name })}
                                        onClick={() => move(index, -1)}
                                    >
                                        <ArrowUp className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="hidden sm:inline-flex"
                                        disabled={index === mine.length - 1 || rule.saving}
                                        aria-label={t("rules.list.downNamed", { name: rule.name })}
                                        title={t("rules.list.downNamed", { name: rule.name })}
                                        onClick={() => move(index, 1)}
                                    >
                                        <ArrowDown className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                disabled={rule.saving}
                                                aria-label={t("rules.list.moreNamed", {
                                                    name: rule.name
                                                })}
                                                title={t("rules.list.moreNamed", {
                                                    name: rule.name
                                                })}
                                            >
                                                <MoreHorizontal
                                                    className="size-4 shrink-0"
                                                    aria-hidden
                                                />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onSelect={() => open(rule)}>
                                                <Pencil className="size-4 shrink-0" aria-hidden />
                                                {t("rules.list.edit")}
                                            </DropdownMenuItem>
                                            {/* On a narrow screen the arrows live here. */}
                                            {index > 0 ? (
                                                <DropdownMenuItem
                                                    className="sm:hidden"
                                                    onSelect={() => move(index, -1)}
                                                >
                                                    <ArrowUp
                                                        className="size-4 shrink-0"
                                                        aria-hidden
                                                    />
                                                    {t("rules.list.up")}
                                                </DropdownMenuItem>
                                            ) : null}
                                            {index < mine.length - 1 ? (
                                                <DropdownMenuItem
                                                    className="sm:hidden"
                                                    onSelect={() => move(index, 1)}
                                                >
                                                    <ArrowDown
                                                        className="size-4 shrink-0"
                                                        aria-hidden
                                                    />
                                                    {t("rules.list.down")}
                                                </DropdownMenuItem>
                                            ) : null}
                                            <DropdownMenuItem onSelect={() => run(rule)}>
                                                <Play className="size-4 shrink-0" aria-hidden />
                                                {t("rules.list.run")}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                disabled={
                                                    mine.length >= core.MAIL_FILTER_LIMITS.filters
                                                }
                                                onSelect={() => duplicate(rule, index)}
                                            >
                                                <Copy className="size-4 shrink-0" aria-hidden />
                                                {t("rules.list.duplicate")}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onSelect={() => void remove(rule)}>
                                                <Trash2 className="size-4 shrink-0" aria-hidden />
                                                {t("rules.list.delete")}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
