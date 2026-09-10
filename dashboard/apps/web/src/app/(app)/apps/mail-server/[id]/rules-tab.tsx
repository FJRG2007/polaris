"use client";

/**
 * Rules on incoming mail: when a message arrives for a matching address from a
 * matching sender, you get a Polaris notification. Spam, bounces and mail from
 * the server's own system addresses never match, and one rule raises at most
 * twenty notifications in ten minutes.
 */

import { useState } from "react";
import { mailInboundRuleSchema } from "@polaris/core";
import { RelativeTime } from "@/components/relative-time";
import { Field, PanelError, usePanelData } from "../ui-bits";
import { BellRing, Pencil, Plus, Trash2 } from "lucide-react";
import { createRuleAction, deleteRuleAction, listRulesAction, updateRuleAction } from "../actions";
import {
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
    Skeleton,
    Switch
} from "@polaris/ui";

type Rule = Extract<
    Awaited<ReturnType<typeof listRulesAction>>,
    { rules: unknown }
>["rules"][number];

export function RulesTab({ serverId }: { serverId: string }) {
    const panel = usePanelData(`rules:${serverId}`, () => listRulesAction(serverId));
    const [editing, setEditing] = useState<Rule | "new" | null>(null);
    const [deleting, setDeleting] = useState<Rule | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function toggle(rule: Rule, enabled: boolean): Promise<void> {
        setError(null);
        const answer = await updateRuleAction({ ...rule, serverId, ruleId: rule.id, enabled });
        if (answer.error) setError(answer.error);
        await panel.reload();
    }

    async function remove(): Promise<void> {
        if (!deleting) return;
        const answer = await deleteRuleAction({ serverId, ruleId: deleting.id });
        if (answer.error) {
            setError(answer.error);
            return;
        }
        setDeleting(null);
        await panel.reload();
    }

    const rules = panel.data?.rules ?? [];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex justify-end">
                <Button size="sm" onClick={() => setEditing("new")}>
                    <Plus />
                    New rule
                </Button>
            </div>
            {error ? <PanelError message={error} /> : null}
            {!panel.data ? (
                panel.error ? (
                    <PanelError message={panel.error} onRetry={() => void panel.reload()} />
                ) : (
                    <Skeleton className="h-40 w-full" />
                )
            ) : rules.length === 0 ? (
                <EmptyState
                    icon={<BellRing />}
                    title="No rules"
                    description="Get a notification when mail you care about arrives: an invoice address, a monitoring sender."
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {rules.map((rule) => (
                        <li key={rule.id} className="flex items-center gap-3 px-3 py-2">
                            <Switch
                                checked={rule.enabled}
                                onChange={(value) => void toggle(rule, value)}
                                aria-label={`Rule ${rule.name} on`}
                            />
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[0.8125rem] text-foreground">
                                    {rule.name}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                    To {rule.recipient || "any address"}, from{" "}
                                    {rule.sender || "anybody"}
                                    {rule.includeSpam ? ", spam included" : ""}
                                </span>
                            </div>
                            {rule.lastFiredAt ? (
                                <span className="hidden text-xs text-foreground-subtle sm:inline">
                                    Last notified <RelativeTime iso={rule.lastFiredAt} />
                                </span>
                            ) : null}
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Edit ${rule.name}`}
                                title={`Edit ${rule.name}`}
                                onClick={() => setEditing(rule)}
                            >
                                <Pencil />
                            </Button>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Delete ${rule.name}`}
                                title={`Delete ${rule.name}`}
                                onClick={() => setDeleting(rule)}
                            >
                                <Trash2 />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {editing ? (
                <RuleDialog
                    serverId={serverId}
                    rule={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => void panel.reload()}
                />
            ) : null}
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                name={deleting?.name ?? ""}
                kind="rule"
                requireTyping={false}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

function RuleDialog({
    serverId,
    rule,
    onClose,
    onSaved
}: {
    serverId: string;
    rule: Rule | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [name, setName] = useState(rule?.name ?? "");
    const [recipient, setRecipient] = useState(rule?.recipient ?? "");
    const [sender, setSender] = useState(rule?.sender ?? "");
    const [includeSpam, setIncludeSpam] = useState(rule?.includeSpam ?? false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const parsed = mailInboundRuleSchema.safeParse({
        serverId,
        name,
        recipient,
        sender,
        includeSpam,
        enabled: rule?.enabled ?? true
    });
    const unchanged =
        rule !== null &&
        name.trim() === rule.name &&
        recipient.trim().toLowerCase() === rule.recipient &&
        sender.trim().toLowerCase() === rule.sender &&
        includeSpam === rule.includeSpam;

    async function submit(): Promise<void> {
        if (!parsed.success || pending || unchanged) return;
        setPending(true);
        setError(null);
        const answer = rule
            ? await updateRuleAction({ ...parsed.data, ruleId: rule.id })
            : await createRuleAction(parsed.data);
        setPending(false);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        onClose();
        onSaved();
    }

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="w-[min(30rem,95vw)] max-w-[min(30rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
                    <DialogDescription>
                        Use * for any run of characters, like *@bank.example. Empty matches
                        everything.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <Field label="Name" required>
                        {(id) => (
                            <Input
                                id={id}
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="Invoices"
                            />
                        )}
                    </Field>
                    <Field label="Sent to">
                        {(id) => (
                            <Input
                                id={id}
                                value={recipient}
                                onChange={(event) => setRecipient(event.target.value)}
                                placeholder="billing@*"
                            />
                        )}
                    </Field>
                    <Field label="Sent from">
                        {(id) => (
                            <Input
                                id={id}
                                value={sender}
                                onChange={(event) => setSender(event.target.value)}
                                placeholder="*@bank.example"
                            />
                        )}
                    </Field>
                    <label className="flex items-center gap-2 text-[0.8125rem] text-foreground">
                        <Checkbox
                            checked={includeSpam}
                            onChange={(event) => setIncludeSpam(event.target.checked)}
                        />
                        Also for mail the spam filter caught
                    </label>
                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!parsed.success || pending || unchanged}>
                            {pending ? "Saving..." : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
