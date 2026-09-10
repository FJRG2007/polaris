"use client";

/**
 * Forwards: an address at one of the server's domains whose mail goes on to
 * other addresses, here or anywhere else, with no mailbox of its own.
 */

import { useState } from "react";
import { mailForwardSchema } from "@polaris/core";
import { Forward, Plus, Trash2 } from "lucide-react";
import { Field, PanelError, usePanelData } from "../ui-bits";
import { createForwardAction, deleteForwardAction, listForwardsAction } from "../actions";
import {
    Button,
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
    Skeleton,
    Textarea
} from "@polaris/ui";

type Loaded = Extract<Awaited<ReturnType<typeof listForwardsAction>>, { forwards: unknown }>;

export function ForwardsTab({ serverId }: { serverId: string }) {
    const panel = usePanelData(`forwards:${serverId}`, () => listForwardsAction(serverId));
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<Loaded["forwards"][number] | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    async function remove(): Promise<void> {
        if (!deleting) return;
        setDeleteError(null);
        const answer = await deleteForwardAction({ serverId, forwardId: deleting.id });
        if (answer.error) {
            setDeleteError(answer.error);
            return;
        }
        setDeleting(null);
        await panel.reload();
    }

    const forwards = panel.data?.forwards ?? [];
    const domains = panel.data?.domains ?? [];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex justify-end">
                <Button size="sm" onClick={() => setCreating(true)} disabled={domains.length === 0}>
                    <Plus />
                    New forward
                </Button>
            </div>
            {!panel.data ? (
                panel.error ? (
                    <PanelError message={panel.error} onRetry={() => void panel.reload()} />
                ) : (
                    <Skeleton className="h-40 w-full" />
                )
            ) : forwards.length === 0 ? (
                <EmptyState icon={<Forward />} title="No forwards" description="Send an address's mail on to other people without giving it a mailbox." />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {forwards.map((forward) => (
                        <li key={forward.id} className="flex items-center gap-3 px-3 py-2">
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[0.8125rem] text-foreground" title={forward.address}>
                                    {forward.address}
                                </span>
                                <span className="truncate text-xs text-muted-foreground" title={forward.recipients.join(", ")}>
                                    To {forward.recipients.join(", ")}
                                </span>
                            </div>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Delete ${forward.address}`}
                                title={`Delete ${forward.address}`}
                                onClick={() => setDeleting(forward)}
                            >
                                <Trash2 />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <CreateForward serverId={serverId} domains={domains} open={creating} onOpenChange={setCreating} onCreated={() => void panel.reload()} />
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                name={deleting?.address ?? ""}
                kind="forward"
                requireTyping={false}
                description="Mail to the address starts bouncing. Nothing already delivered is touched."
                error={deleteError}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

function CreateForward({
    serverId,
    domains,
    open,
    onOpenChange,
    onCreated
}: {
    serverId: string;
    domains: Loaded["domains"];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}) {
    const [domainId, setDomainId] = useState("");
    const [localPart, setLocalPart] = useState("");
    const [recipients, setRecipients] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const chosenDomain = domainId || domains[0]?.id || "";
    const list = recipients
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    const parsed = mailForwardSchema.safeParse({ serverId, domainId: chosenDomain, localPart, recipients: list });
    const issue = (path: string, typed: string): string | null =>
        parsed.success || !typed.trim() ? null : (parsed.error.issues.find((entry) => entry.path[0] === path)?.message ?? null);

    async function submit(): Promise<void> {
        if (!parsed.success || pending) return;
        setPending(true);
        setError(null);
        const answer = await createForwardAction(parsed.data);
        setPending(false);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        setLocalPart("");
        setRecipients("");
        onOpenChange(false);
        onCreated();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(32rem,95vw)] max-w-[min(32rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>New forward</DialogTitle>
                    <DialogDescription>Receivers may treat forwarded mail as suspicious when the sender's domain enforces DMARC.</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label="Address" required error={issue("localPart", localPart)}>
                            {(id) => <Input id={id} value={localPart} onChange={(event) => setLocalPart(event.target.value)} placeholder="team" />}
                        </Field>
                        <Field label="Domain" required>
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
                    <Field label="Send to" required error={issue("recipients", recipients)} hint="One address per line, or separated by commas.">
                        {(id) => <Textarea id={id} rows={3} value={recipients} onChange={(event) => setRecipients(event.target.value)} />}
                    </Field>
                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!parsed.success || pending}>
                            {pending ? "Creating..." : "Create"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
