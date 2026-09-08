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
import { useState, useTransition } from "react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailRuleView } from "@/lib/mailbox/rules";
import type { MailLabelView } from "@/lib/mailbox/labels";
import type { MailFolderView } from "@/lib/mailbox/views";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, Input, Select, Switch, useToast } from "@polaris/ui";
import { deleteRuleAction, saveRuleAction } from "@/app/(app)/mail/actions";

const FIELDS = [
    { value: "from", label: "the sender" },
    { value: "recipient", label: "any recipient" },
    { value: "to", label: "the To line" },
    { value: "subject", label: "the subject" },
    { value: "body", label: "the message" },
    { value: "list", label: "the mailing list" },
    { value: "attachment", label: "attachments (yes or no)" },
    { value: "size", label: "the size in bytes" }
];

const OPERATORS = [
    { value: "contains", label: "contains" },
    { value: "not-contains", label: "does not contain" },
    { value: "is", label: "is exactly" },
    { value: "is-not", label: "is not" },
    { value: "starts-with", label: "starts with" },
    { value: "ends-with", label: "ends with" },
    { value: "matches", label: "matches the pattern" },
    { value: "greater-than", label: "is more than" },
    { value: "less-than", label: "is less than" }
];

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
    const [accountId, setAccountId] = useState(accounts[0]!.id);
    const account = accounts.find((one) => one.id === accountId) ?? accounts[0]!;
    const mine = rules[account.id] ?? [];
    const [adding, setAdding] = useState(false);

    return (
        <div>
            <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />

            <div className="mb-3 flex items-center justify-between">
                <div>
                    <h2 className="text-[13px] font-medium">Filters on {account.address}</h2>
                    <p className="text-[12px] text-muted-foreground">
                        Run on arrival, top to bottom. A rule set to stop there is the last one a message meets.
                    </p>
                </div>
                <Button variant="secondary" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    New filter
                </Button>
            </div>

            {mine.length === 0 && !adding ? (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
                    No filters. Everything that arrives goes to the inbox.
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
                                <p className="truncate text-[13px] font-medium" title={rule.name}>{rule.name}</p>
                                <p className="text-[12px] text-muted-foreground">{describe(rule, folders, labels)}</p>
                                <p className="text-[11px] text-foreground-subtle">
                                    {rule.enabled ? "On" : "Off"}
                                    {rule.stop ? " - stops the filters below it" : ""}
                                    {rule.matchCount > 0 ? ` - matched ${rule.matchCount} times` : ""}
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete the filter ${rule.name}`}
                                title={`Delete the filter ${rule.name}`}
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
    rule: MailRuleView,
    folders: readonly MailFolderView[],
    labels: readonly MailLabelView[]
): string {
    const joiner = rule.match === "all" ? " and " : " or ";
    const conditions = rule.conditions
        .map((condition) => {
            const field = FIELDS.find((one) => one.value === condition.field)?.label ?? condition.field;
            const operator = OPERATORS.find((one) => one.value === condition.operator)?.label ?? condition.operator;
            return `${field} ${operator} "${condition.value}"`;
        })
        .join(joiner);
    const actions = rule.actions
        .map((action) => {
            switch (action.kind) {
                case "move":
                    return `move it to ${folders.find((folder) => folder.id === action.folder)?.name ?? "a folder"}`;
                case "label":
                    return `label it ${labels.find((label) => label.id === action.label)?.name ?? ""}`.trim();
                case "star":
                    return "star it";
                case "read":
                    return "mark it read";
                case "archive":
                    return "archive it";
                case "trash":
                    return "put it in the trash";
                case "junk":
                    return "put it in spam";
                case "pin":
                    return "pin it";
                case "mute":
                    return "mute the conversation";
                case "forward":
                    return `send it on to ${action.to}`;
            }
        })
        .join(", ");
    return `If ${conditions}, ${actions}.`;
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
    const [saving, startSaving] = useTransition();

    const actionOptions = [
        { value: "archive", label: "archive it" },
        ...(folders.length > 0 ? [{ value: "move", label: "move it to a folder" }] : []),
        ...(labels.length > 0 ? [{ value: "label", label: "put a label on it" }] : []),
        { value: "star", label: "star it" },
        { value: "read", label: "mark it read" },
        { value: "junk", label: "put it in spam" },
        { value: "trash", label: "put it in the trash" },
        { value: "pin", label: "pin it" },
        { value: "mute", label: "mute the conversation" },
        { value: "forward", label: "send it on to somebody" }
    ];

    function action(): core.MailRuleAction {
        if (actionKind === "move") return { kind: "move", folder: folderId };
        if (actionKind === "label") return { kind: "label", label: labelId };
        if (actionKind === "forward") return { kind: "forward", to: forwardTo.trim().toLowerCase() };
        return { kind: actionKind } as core.MailRuleAction;
    }

    return (
        <div className="mt-3 space-y-3 rounded-md border border-border p-3">
            <label className="block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    Name it <span aria-hidden>*</span>
                </span>
                <Input
                    value={name}
                    autoFocus
                    placeholder="Invoices into Accounts"
                    onChange={(event) => setName(event.target.value)}
                />
            </label>

            <div className="flex flex-wrap items-end gap-2">
                <span className="pb-2 text-[13px] text-muted-foreground">If</span>
                <Select
                    value={field}
                    onValueChange={setField}
                    options={FIELDS}
                    aria-label="What to look at"
                    className="w-44"
                />
                <Select
                    value={operator}
                    onValueChange={setOperator}
                    options={OPERATORS}
                    aria-label="How to compare it"
                    className="w-44"
                />
                <Input
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    aria-label="What to look for"
                    className="w-52"
                />
            </div>

            <div className="flex flex-wrap items-end gap-2">
                <span className="pb-2 text-[13px] text-muted-foreground">then</span>
                <Select
                    value={actionKind}
                    onValueChange={setActionKind}
                    options={actionOptions}
                    aria-label="What to do"
                    className="w-56"
                />
                {actionKind === "move" ? (
                    <Select
                        value={folderId}
                        onValueChange={setFolderId}
                        options={folders.map((folder) => ({ value: folder.id, label: folder.name }))}
                        aria-label="Which folder"
                        className="w-48"
                    />
                ) : null}
                {actionKind === "label" ? (
                    <Select
                        value={labelId}
                        onValueChange={setLabelId}
                        options={labels.map((label) => ({ value: label.id, label: label.name }))}
                        aria-label="Which label"
                        className="w-48"
                    />
                ) : null}
                {actionKind === "forward" ? (
                    <Input
                        value={forwardTo}
                        inputMode="email"
                        placeholder="them@example.com"
                        aria-label="Where to send it"
                        className="w-56"
                        onChange={(event) => setForwardTo(event.target.value)}
                    />
                ) : null}
            </div>

            {actionKind === "forward" ? (
                <p className="text-[12px] text-foreground-subtle">
                    A copy is sent from this mailbox, and replies to it go to whoever wrote the
                    original. It will not send to an address you have here - that is a loop - and a
                    message that has already been forwarded once is left alone.
                </p>
            ) : null}

            <label className="flex items-center gap-2 text-[13px]">
                <Switch checked={stop} onChange={setStop} aria-label="Stop the filters below this one" />
                Stop here - do not run the filters below this one
            </label>
            <label className="flex items-center gap-2 text-[13px]">
                <Switch
                    checked={applyToExisting}
                    onChange={setApplyToExisting}
                    aria-label="Also run it over the mail already here"
                />
                Also run it over the mail already in the inbox
            </label>

            {problem ? <p className="text-[13px] text-danger">{problem}</p> : null}

            <div className="flex gap-2">
                <Button
                    disabled={saving || !name.trim() || !value.trim()}
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
                            toast.show({ title: "Filter saved." });
                            onDone();
                        })
                    }
                >
                    Save the filter
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}
