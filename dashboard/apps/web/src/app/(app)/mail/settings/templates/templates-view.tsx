"use client";

/**
 * Making, changing and throwing away message templates.
 *
 * A template is what somebody writes often enough to keep - the answer to the
 * question everybody asks, the note that goes with an invoice. It is inserted
 * from the composer's toolbar where the cursor is, and its subject fills an
 * empty subject line. Its body is written in the same editor the composer uses,
 * so it arrives looking the way it was written.
 */

import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { useMemo, useState, useTransition } from "react";
import { FileText, Pencil, Plus, Trash2 } from "lucide-react";
import type { MailTemplateView } from "@/lib/mailbox/templates";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { deleteTemplateAction, saveTemplateAction } from "@/app/(app)/mail/actions";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    useToast
} from "@polaris/ui";

/** Every mailbox, as the menu offers it. */
const EVERY = "every";

interface Draft {
    readonly name: string;
    readonly subject: string;
    readonly body: string;
    readonly accountId: string | null;
}

const EMPTY: Draft = { name: "", subject: "", body: "", accountId: null };

export function TemplatesView({
    templates,
    accounts
}: {
    templates: MailTemplateView[];
    accounts: { id: string; label: string }[];
}) {
    const router = useRouter();
    const toast = useToast();
    /** The template being written: null closed, "" a new one, an id one being changed. */
    const [editing, setEditing] = useState<string | null>(null);
    const [removing, setRemoving] = useState<MailTemplateView | null>(null);
    const [busy, startBusy] = useTransition();

    const accountLabel = (accountId: string | null): string =>
        accountId
            ? (accounts.find((one) => one.id === accountId)?.label ?? "A mailbox you no longer have")
            : "Every mailbox";

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                    <h2 className="text-[13px] font-medium">Templates</h2>
                    <p className="text-[12px] text-muted-foreground">
                        Insert one from the composer's toolbar. A template's subject fills the
                        subject line when it is empty.
                    </p>
                </div>
                <Button onClick={() => setEditing("")}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    New template
                </Button>
            </div>

            {templates.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
                    No templates yet.
                </p>
            ) : (
                <ul className="space-y-1">
                    {templates.map((template) => (
                        <li
                            key={template.id}
                            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
                        >
                            <FileText className="size-4 shrink-0 text-foreground-subtle" aria-hidden />
                            <div className="min-w-0 flex-1">
                                <span className="block truncate text-[13px]" title={template.name}>
                                    {template.name}
                                </span>
                                <span className="block truncate text-[12px] text-foreground-subtle">
                                    {accountLabel(template.accountId)}
                                    {template.subject ? ` - ${template.subject}` : ""}
                                </span>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Change the template ${template.name}`}
                                title={`Change the template ${template.name}`}
                                onClick={() => setEditing(template.id)}
                            >
                                <Pencil className="size-4 shrink-0" aria-hidden />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete the template ${template.name}`}
                                title={`Delete the template ${template.name}`}
                                onClick={() => setRemoving(template)}
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            {editing !== null ? (
                <TemplateEditor
                    key={editing || "new"}
                    templateId={editing || null}
                    initial={
                        editing
                            ? (templates.find((one) => one.id === editing) ?? EMPTY)
                            : EMPTY
                    }
                    accounts={accounts}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        router.refresh();
                    }}
                />
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    name={removing.name}
                    kind="template"
                    requireTyping={false}
                    title={`Delete ${removing.name}?`}
                    question={`Delete the template ${removing.name}?`}
                    description="Messages already written with it are not touched."
                    confirmLabel="Delete"
                    pending={busy}
                    onOpenChange={(next) => (next ? undefined : setRemoving(null))}
                    onConfirm={() =>
                        startBusy(async () => {
                            const answer = await deleteTemplateAction(removing.id);
                            const said = refusalOf(answer);
                            if (said) {
                                toast.show({ title: said });
                                return;
                            }
                            toast.show({ title: `${removing.name} is gone.` });
                            setRemoving(null);
                            router.refresh();
                        })
                    }
                />
            ) : null}
        </div>
    );
}

function TemplateEditor({
    templateId,
    initial,
    accounts,
    onClose,
    onSaved
}: {
    templateId: string | null;
    initial: Draft;
    accounts: { id: string; label: string }[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const toast = useToast();
    const [draft, setDraft] = useState<Draft>(initial);
    const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
    const [saving, startSaving] = useTransition();

    /** What is missing before Save means anything. Incomplete rather than
     *  wrong: an empty field is marked required, never "not valid". */
    const complete = draft.name.trim() !== "" && draft.body.trim() !== "";
    const dirty = useMemo(
        () =>
            draft.name !== initial.name ||
            draft.subject !== initial.subject ||
            draft.body !== initial.body ||
            draft.accountId !== initial.accountId,
        [draft, initial]
    );
    /** The same rules the server applies, run as somebody types. */
    const checked = core.mailTemplateSchema.safeParse(draft);
    const invalid = complete && !checked.success ? checked.error.issues[0] : undefined;

    function save(): void {
        startSaving(async () => {
            const answer = await saveTemplateAction(templateId, draft);
            const said = refusalOf(answer);
            if (said) {
                setProblem({
                    field: "field" in answer && typeof answer.field === "string" ? answer.field : "",
                    message: said
                });
                return;
            }
            toast.show({ title: templateId ? "Template saved." : "Template made." });
            onSaved();
        });
    }

    const nameProblem =
        problem?.field === "name"
            ? problem.message
            : invalid?.path[0] === "name"
              ? invalid.message
              : "";

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{templateId ? "Change the template" : "New template"}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            Name <span aria-hidden>*</span>
                        </span>
                        <Input
                            value={draft.name}
                            placeholder="Invoice follow-up"
                            aria-invalid={nameProblem ? true : undefined}
                            onChange={(event) => {
                                setDraft((held) => ({ ...held, name: event.target.value }));
                                setProblem(null);
                            }}
                        />
                        {nameProblem ? (
                            <span className="mt-1 block text-[12px] text-danger">{nameProblem}</span>
                        ) : null}
                    </label>

                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            Offered when writing from
                        </span>
                        <Select
                            aria-label="Which mailbox this template is offered for"
                            value={draft.accountId ?? EVERY}
                            onValueChange={(value) =>
                                setDraft((held) => ({
                                    ...held,
                                    accountId: value === EVERY ? null : value
                                }))
                            }
                            options={[
                                { value: EVERY, label: "Every mailbox" },
                                ...accounts.map((account) => ({
                                    value: account.id,
                                    label: account.label
                                }))
                            ]}
                        />
                    </label>

                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">Subject</span>
                        <Input
                            value={draft.subject}
                            placeholder="Left empty, the subject line is not touched"
                            onChange={(event) =>
                                setDraft((held) => ({ ...held, subject: event.target.value }))
                            }
                        />
                    </label>

                    <div>
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            What it says <span aria-hidden>*</span>
                        </span>
                        <div className="rounded-md border border-border px-2 py-1.5">
                            <RichTextEditor
                                value={draft.body}
                                onChange={(body) => setDraft((held) => ({ ...held, body }))}
                                placeholder="Write the template"
                                className="min-h-[10rem]"
                            />
                        </div>
                        {invalid && invalid.path[0] === "body" ? (
                            <span className="mt-1 block text-[12px] text-danger">{invalid.message}</span>
                        ) : null}
                    </div>

                    {problem && problem.field !== "name" ? (
                        <p className="text-[12px] text-danger">{problem.message}</p>
                    ) : null}

                    <div className="flex gap-2">
                        <Button
                            disabled={saving || !complete || !dirty || Boolean(invalid)}
                            onClick={save}
                        >
                            {saving ? "Saving..." : templateId ? "Save" : "Make it"}
                        </Button>
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
