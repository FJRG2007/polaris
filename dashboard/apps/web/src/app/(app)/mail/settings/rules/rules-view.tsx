"use client";

/**
 * Filters.
 *
 * Written as sentences rather than as a grid of dropdowns: "If the sender
 * contains invoices@, move it to Accounts." A filter is something people write
 * once and read back a year later trying to work out why a message vanished, and
 * the reading is the part that has to be easy.
 *
 * The order matters and the screen says so, because a rule that stops the ones
 * below it is the single most confusing thing about every filter system ever
 * built.
 */

import type * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { addressState } from "@/app/(app)/mail/address-state";
import type { MailRuleView } from "@/lib/mailbox/rules";
import type { MailLabelView } from "@/lib/mailbox/labels";
import type { MailFolderView } from "@/lib/mailbox/views";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, Input, Select, Switch, useToast } from "@polaris/ui";
import { deleteRuleAction, saveRuleAction } from "@/app/(app)/mail/actions";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** What a condition can look at, named in `mailSettings.rules.fields.<key>`. */
const FIELDS = {
    from: "from",
    recipient: "recipient",
    to: "to",
    subject: "subject",
    body: "body",
    list: "list",
    attachment: "attachment",
    size: "size"
} as const;

/** How it compares, named in `mailSettings.rules.operators.<key>`. */
const OPERATORS = {
    contains: "contains",
    "not-contains": "notContains",
    is: "is",
    "is-not": "isNot",
    "starts-with": "startsWith",
    "ends-with": "endsWith",
    matches: "matches",
    "greater-than": "greaterThan",
    "less-than": "lessThan"
} as const;

function fieldOptions(t: NamespaceTranslator<"mailSettings">) {
    return Object.entries(FIELDS).map(([value, key]) => ({ value, label: t(`rules.fields.${key}`) }));
}

function operatorOptions(t: NamespaceTranslator<"mailSettings">) {
    return Object.entries(OPERATORS).map(([value, key]) => ({ value, label: t(`rules.operators.${key}`) }));
}

export function RulesView({
    accounts,
    folders,
    labels,
    rules
}: {
    accounts: MailAccountView[];
    folders: MailFolderView[];
    labels: MailLabelView[];
    rules: Record<string, MailRuleView[]>;
}) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;
    const mine = rules[account.id] ?? [];
    const [adding, setAdding] = useState(false);

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />

            <div className="mb-3 flex items-center justify-between">
                <div>
                    <h2 className="text-[13px] font-medium">{t("rules.title", { address: account.address })}</h2>
                    <p className="text-[12px] text-muted-foreground">{t("rules.hint")}</p>
                </div>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("rules.new")}
                </Button>
            </div>

            {mine.length === 0 && !adding ? (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
                    {t("rules.empty")}
                </p>
            ) : null}

            <ul className="space-y-2">
                {mine.map((rule, index) => (
                    <li key={rule.id} className="rounded-md border border-border bg-card px-3 py-2">
                        <div className="flex items-start gap-3">
                            <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-foreground-subtle">
                                {index + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-[13px] font-medium" title={rule.name}>
                                    {rule.name}
                                </p>
                                <p className="text-[12px] text-muted-foreground">
                                    {describe(t, rule, folders, labels)}
                                </p>
                                <p className="text-[11px] text-foreground-subtle">
                                    {rule.enabled ? t("rules.on") : t("rules.off")}
                                    {rule.stop ? t("rules.stops") : ""}
                                    {rule.matchCount > 0 ? t("rules.matched", { count: rule.matchCount }) : ""}
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t("rules.deleteNamed", { name: rule.name })}
                                title={t("rules.deleteNamed", { name: rule.name })}
                                onClick={() =>
                                    void (async () => {
                                        const answer = await deleteRuleAction(account.id, rule.id);
                                        const said = refusalOf(answer);
                                        if (said) {
                                            toast.show({ title: said });
                                            return;
                                        }
                                        router.refresh();
                                    })()
                                }
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                            </Button>
                        </div>
                    </li>
                ))}
            </ul>

            {adding ? (
                <RuleForm
                    accountId={account.id}
                    folders={folders.filter((folder) => folder.accountId === account.id)}
                    labels={labels}
                    onDone={() => {
                        setAdding(false);
                        router.refresh();
                    }}
                    onCancel={() => setAdding(false)}
                />
            ) : null}
        </div>
    );
}

/** A rule as a sentence, which is how it will be read back a year from now. */
function describe(
    t: NamespaceTranslator<"mailSettings">,
    rule: MailRuleView,
    folders: readonly MailFolderView[],
    labels: readonly MailLabelView[]
): string {
    const joiner = rule.match === "all" ? t("rules.and") : t("rules.or");
    const conditions = rule.conditions
        .map((condition) => {
            const fieldKey = FIELDS[condition.field as keyof typeof FIELDS];
            const operatorKey = OPERATORS[condition.operator as keyof typeof OPERATORS];
            return t("rules.condition", {
                field: fieldKey ? t(`rules.fields.${fieldKey}`) : condition.field,
                operator: operatorKey ? t(`rules.operators.${operatorKey}`) : condition.operator,
                value: condition.value
            });
        })
        .join(joiner);
    const actions = rule.actions
        .map((action) => {
            switch (action.kind) {
                case "move": {
                    const folder = folders.find((one) => one.id === action.folder)?.name;
                    return folder ? t("rules.said.move", { folder }) : t("rules.said.moveSomewhere");
                }
                case "label": {
                    const label = labels.find((one) => one.id === action.label)?.name;
                    return label ? t("rules.said.label", { label }) : t("rules.said.labelSomething");
                }
                case "star":
                    return t("rules.actions.star");
                case "read":
                    return t("rules.actions.read");
                case "archive":
                    return t("rules.actions.archive");
                case "trash":
                    return t("rules.actions.trash");
                case "junk":
                    return t("rules.actions.junk");
                case "pin":
                    return t("rules.actions.pin");
                case "mute":
                    return t("rules.actions.mute");
                case "forward":
                    return t("rules.said.forward", { to: action.to });
            }
        })
        .join(", ");
    return t("rules.sentence", { conditions, actions });
}

function RuleForm({
    accountId,
    folders,
    labels,
    onDone,
    onCancel
}: {
    accountId: string;
    folders: MailFolderView[];
    labels: MailLabelView[];
    onDone: () => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const tm = useTranslations("mail");
    const tc = useTranslations("common");
    const [name, setName] = useState("");
    const [field, setField] = useState("from");
    const [operator, setOperator] = useState("contains");
    const [value, setValue] = useState("");
    const [actionKind, setActionKind] = useState("archive");
    const [folderId, setFolderId] = useState(folders[0]?.id ?? "");
    const [labelId, setLabelId] = useState(labels[0]?.id ?? "");
    const [forwardTo, setForwardTo] = useState("");
    const [stop, setStop] = useState(false);
    const [applyToExisting, setApplyToExisting] = useState(false);
    const [problem, setProblem] = useState("");
    const [saving, startSaving] = useBusy();

    const actionOptions = [
        { value: "archive", label: t("rules.actions.archive") },
        ...(folders.length > 0 ? [{ value: "move", label: t("rules.actions.move") }] : []),
        ...(labels.length > 0 ? [{ value: "label", label: t("rules.actions.label") }] : []),
        { value: "star", label: t("rules.actions.star") },
        { value: "read", label: t("rules.actions.read") },
        { value: "junk", label: t("rules.actions.junk") },
        { value: "trash", label: t("rules.actions.trash") },
        { value: "pin", label: t("rules.actions.pin") },
        { value: "mute", label: t("rules.actions.mute") },
        { value: "forward", label: t("rules.actions.forward") }
    ];

    /** The forward address as the form reads it. Answered while it is typed
     *  against the same schema the action is refused by, because this is the one
     *  filter that sends mail off the machine and a round trip is a poor way to
     *  find out an address was mistyped. */
    const forwardAddress = addressState(forwardTo, []);
    const forwarding = actionKind === "forward";

    function action(): core.MailRuleAction {
        if (actionKind === "move") return { kind: "move", folder: folderId };
        if (actionKind === "label") return { kind: "label", label: labelId };
        if (actionKind === "forward")
            return { kind: "forward", to: forwardTo.trim().toLowerCase() };
        return { kind: actionKind } as core.MailRuleAction;
    }

    return (
        <div className="mt-3 space-y-3 rounded-md border border-border p-3">
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    {t("rules.name")} <span aria-hidden>*</span>
                </span>
                <Input
                    value={name}
                    autoFocus
                    placeholder={t("rules.namePlaceholder")}
                    onChange={(event) => setName(event.target.value)}
                />
            </label>

            <div className="flex flex-wrap items-end gap-2">
                <span className="pb-2 text-[13px] text-muted-foreground">{t("rules.if")}</span>
                <Select
                    value={field}
                    onValueChange={setField}
                    options={fieldOptions(t)}
                    aria-label={t("rules.fieldLabel")}
                    className="w-44"
                />
                <Select
                    value={operator}
                    onValueChange={setOperator}
                    options={operatorOptions(t)}
                    aria-label={t("rules.operatorLabel")}
                    className="w-44"
                />
                <Input
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    aria-label={t("rules.valueLabel")}
                    className="w-52"
                />
            </div>

            <div className="flex flex-wrap items-end gap-2">
                <span className="pb-2 text-[13px] text-muted-foreground">{t("rules.then")}</span>
                <Select
                    value={actionKind}
                    onValueChange={setActionKind}
                    options={actionOptions}
                    aria-label={t("rules.actionLabel")}
                    className="w-56"
                />
                {actionKind === "move" ? (
                    <Select
                        value={folderId}
                        onValueChange={setFolderId}
                        options={folders.map((folder) => ({
                            value: folder.id,
                            label: folder.name
                        }))}
                        aria-label={t("rules.folderLabel")}
                        className="w-48"
                    />
                ) : null}
                {actionKind === "label" ? (
                    <Select
                        value={labelId}
                        onValueChange={setLabelId}
                        options={labels.map((label) => ({ value: label.id, label: label.name }))}
                        aria-label={t("rules.labelLabel")}
                        className="w-48"
                    />
                ) : null}
                {forwarding ? (
                    <div className="w-56">
                        <Input
                            value={forwardTo}
                            inputMode="email"
                            placeholder="them@example.com"
                            aria-label={t("rules.forwardLabel")}
                            aria-invalid={forwardAddress === "invalid" ? true : undefined}
                            aria-describedby="forward-address"
                            onChange={(event) => setForwardTo(event.target.value)}
                        />
                        <span
                            id="forward-address"
                            className="mt-1 block text-[12px] text-danger"
                            role={forwardAddress === "invalid" ? "alert" : undefined}
                        >
                            {forwardAddress === "invalid" ? tm("errors.notEmail") : ""}
                        </span>
                    </div>
                ) : null}
            </div>

            {actionKind === "forward" ? (
                <p className="text-[12px] text-foreground-subtle">
                    {t("rules.forwardHint")}
                </p>
            ) : null}

            <label className="flex items-center gap-2 text-[13px]">
                <Switch
                    checked={stop}
                    onChange={setStop}
                    aria-label={t("rules.stopLabel")}
                />
                {t("rules.stop")}
            </label>
            <label className="flex items-center gap-2 text-[13px]">
                <Switch
                    checked={applyToExisting}
                    onChange={setApplyToExisting}
                    aria-label={t("rules.existingLabel")}
                />
                {t("rules.existing")}
            </label>

            {problem ? <p className="text-[13px] text-danger">{problem}</p> : null}

            <div className="flex gap-2">
                <Button
                    disabled={
                        saving ||
                        !name.trim() ||
                        !value.trim() ||
                        (forwarding && forwardAddress !== "ok")
                    }
                    onClick={() =>
                        startSaving(async () => {
                            setProblem("");
                            const answer = await saveRuleAction(accountId, null, {
                                name,
                                enabled: true,
                                // One condition per rule from this form, so "all"
                                // and "any" mean the same thing. The stored
                                // shape carries several because the engine and
                                // the API accept them; the form asks for the
                                // one everybody writes.
                                match: "all",
                                conditions: [{ field, operator, value }],
                                actions: [action()],
                                stop,
                                applyToExisting
                            });
                            const said = refusalOf(answer);
                            if (said) {
                                setProblem(said);
                                return;
                            }
                            toast.show({ title: t("rules.saved") });
                            onDone();
                        })
                    }
                >
                    {t("rules.save")}
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                    {tc("actions.cancel")}
                </Button>
            </div>
        </div>
    );
}
