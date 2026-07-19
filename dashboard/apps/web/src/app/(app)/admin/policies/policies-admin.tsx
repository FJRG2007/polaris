"use client";

/**
 * Client view for policy management. Policies are authored as JSON documents, so
 * the editor is a plain textarea seeded with a working template; the server
 * validates the shape on save. Each policy card summarises its statements, lists
 * its attachments, and offers attach/detach and delete controls.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus, Trash2, X } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import {
    attachPolicyAction,
    createPolicyAction,
    deletePolicyAction,
    detachPolicyAction,
    updatePolicyAction
} from "./actions";

export interface PrincipalOption {
    type: "user" | "group" | "role";
    id: string;
    label: string;
}
export interface PolicyAttachmentView {
    principalType: PrincipalOption["type"];
    principalId: string;
    label: string;
}
export interface PolicyRow {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    document: string;
    attachments: PolicyAttachmentView[];
}

const TEMPLATE = JSON.stringify(
    {
        statements: [
            { effect: "allow", actions: ["drive.read", "drive.download"], resources: ["drive:CONNECTION_ID:*"] }
        ]
    },
    null,
    2
);

/** One-line summary of a document's statements, tolerant of malformed JSON. */
function summarize(document: string): string {
    try {
        const parsed = JSON.parse(document) as { statements?: { effect?: string; actions?: string[] }[] };
        const statements = parsed.statements ?? [];
        if (statements.length === 0) return "No statements";
        return statements
            .map((statement) => `${statement.effect ?? "?"}: ${(statement.actions ?? []).join(", ")}`)
            .join("  -  ");
    } catch {
        return "Invalid document";
    }
}

export function PoliciesAdmin({
    policies,
    principals
}: {
    policies: PolicyRow[];
    principals: PrincipalOption[];
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [document, setDocument] = useState(TEMPLATE);
    const [error, setError] = useState<string | null>(null);

    function mutate(run: () => Promise<unknown>) {
        startTransition(async () => {
            await run();
            router.refresh();
        });
    }

    function onCreate() {
        setError(null);
        startTransition(async () => {
            const result = await createPolicyAction(name.trim(), description.trim(), document);
            if (result.error) {
                setError(result.error);
                return;
            }
            setName("");
            setDescription("");
            setDocument(TEMPLATE);
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader>
                    <CardTitle>New policy</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Input placeholder="Policy name" value={name} onChange={(event) => setName(event.target.value)} />
                        <Input
                            placeholder="Description (optional)"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </div>
                    <textarea
                        className="min-h-40 rounded-md border border-input bg-surface p-3 font-mono text-xs"
                        value={document}
                        onChange={(event) => setDocument(event.target.value)}
                        spellCheck={false}
                    />
                    <p className="text-xs text-muted-foreground">
                        Actions are capability keys (e.g. <code>drive.read</code>) or Drive verbs; resources are{" "}
                        <code>drive:CONNECTION_ID:PATH</code> or <code>*</code>. An explicit deny always wins.
                    </p>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div>
                        <Button onClick={onCreate} disabled={pending || !name.trim()}>
                            <Plus className="size-4" />
                            Create policy
                        </Button>
                    </div>
                </CardBody>
            </Card>

            {policies.length === 0 ? (
                <Card>
                    <CardBody className="p-8 text-center text-sm text-muted-foreground">No policies yet.</CardBody>
                </Card>
            ) : (
                policies.map((policy) => (
                    <PolicyCard
                        key={policy.id}
                        policy={policy}
                        principals={principals}
                        onMutate={mutate}
                        disabled={pending}
                    />
                ))
            )}
        </div>
    );
}

function PolicyCard({
    policy,
    principals,
    onMutate,
    disabled
}: {
    policy: PolicyRow;
    principals: PrincipalOption[];
    onMutate: (run: () => Promise<unknown>) => void;
    disabled: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState(policy.name);
    const [description, setDescription] = useState(policy.description ?? "");
    const [document, setDocument] = useState(() => {
        try {
            return JSON.stringify(JSON.parse(policy.document), null, 2);
        } catch {
            return policy.document;
        }
    });
    const [attach, setAttach] = useState("");
    const [error, setError] = useState<string | null>(null);

    function onSave() {
        setError(null);
        onMutateSave();
    }
    function onMutateSave() {
        onMutate(async () => {
            const result = await updatePolicyAction(policy.id, name.trim(), description.trim(), document);
            if (result.error) setError(result.error);
        });
    }

    function onAttach() {
        if (!attach) return;
        const [type, id] = attach.split(":");
        onMutate(() => attachPolicyAction(policy.id, type as PrincipalOption["type"], id as string));
        setAttach("");
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <CardTitle className="flex items-center gap-2">
                            {policy.name}
                            {policy.isSystem ? <Badge>system</Badge> : null}
                        </CardTitle>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{summarize(policy.document)}</p>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" aria-label="Toggle details" onClick={() => setOpen((value) => !value)}>
                            <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
                        </Button>
                        {!policy.isSystem ? (
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Delete policy ${policy.name}`}
                                disabled={disabled}
                                onClick={() => onMutate(() => deletePolicyAction(policy.id))}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        ) : null}
                    </div>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Attached to:</span>
                    {policy.attachments.length === 0 ? (
                        <span className="text-xs text-muted-foreground">nobody</span>
                    ) : (
                        policy.attachments.map((attachment) => (
                            <span
                                key={`${attachment.principalType}:${attachment.principalId}`}
                                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                            >
                                {attachment.label}
                                <button
                                    type="button"
                                    aria-label={`Detach ${attachment.label}`}
                                    disabled={disabled}
                                    onClick={() =>
                                        onMutate(() =>
                                            detachPolicyAction(policy.id, attachment.principalType, attachment.principalId)
                                        )
                                    }
                                    className="text-muted-foreground hover:text-foreground"
                                >
                                    <X className="size-3" />
                                </button>
                            </span>
                        ))
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <select
                        className="h-9 flex-1 rounded-md border border-input bg-surface px-3 text-sm"
                        value={attach}
                        onChange={(event) => setAttach(event.target.value)}
                    >
                        <option value="">Attach to...</option>
                        {principals.map((principal) => (
                            <option key={`${principal.type}:${principal.id}`} value={`${principal.type}:${principal.id}`}>
                                {principal.label}
                            </option>
                        ))}
                    </select>
                    <Button size="sm" variant="ghost" disabled={disabled || !attach} onClick={onAttach}>
                        <Plus className="size-4" />
                        Attach
                    </Button>
                </div>

                {open ? (
                    <div className="flex flex-col gap-3 border-t border-border pt-3">
                        {!policy.isSystem ? (
                            <>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <Input value={name} onChange={(event) => setName(event.target.value)} />
                                    <Input
                                        placeholder="Description"
                                        value={description}
                                        onChange={(event) => setDescription(event.target.value)}
                                    />
                                </div>
                                <textarea
                                    className="min-h-40 rounded-md border border-input bg-surface p-3 font-mono text-xs"
                                    value={document}
                                    onChange={(event) => setDocument(event.target.value)}
                                    spellCheck={false}
                                />
                                {error ? <p className="text-sm text-danger">{error}</p> : null}
                                <div>
                                    <Button size="sm" disabled={disabled} onClick={onSave}>
                                        Save changes
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
                                {document}
                            </pre>
                        )}
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}
