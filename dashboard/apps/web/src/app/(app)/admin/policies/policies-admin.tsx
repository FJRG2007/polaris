"use client";

/**
 * Client view for policy management. Policies are authored as JSON documents, so
 * the editor is the shared JSON editor seeded with a working template; the server
 * validates the shape on save. Each policy card summarises its statements, lists
 * its attachments, and offers attach/detach and delete controls.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus, Trash2, X } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import { JsonEditor, JsonView, prettyJson } from "@/components/json-view";
import { PeoplePicker } from "@/components/people-picker";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    attachPolicyAction,
    createPolicyAction,
    deletePolicyAction,
    detachPolicyAction,
    findPolicyPeopleAction,
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
            {
                effect: "allow",
                actions: ["drive.read", "drive.download"],
                resources: ["drive:CONNECTION_ID:*"]
            }
        ]
    },
    null,
    2
);

/** One-line summary of a document's statements, tolerant of malformed JSON. */
function summarize(document: string, t: NamespaceTranslator<"admin">): string {
    try {
        const parsed = JSON.parse(document) as {
            statements?: { effect?: string; actions?: string[] }[];
        };
        const statements = parsed.statements ?? [];
        if (statements.length === 0) return t("policies.summary.none");
        return statements
            .map(
                (statement) => `${statement.effect ?? "?"}: ${(statement.actions ?? []).join(", ")}`
            )
            .join("  -  ");
    } catch {
        return t("policies.summary.invalid");
    }
}

export function PoliciesAdmin({
    policies,
    principals
}: {
    policies: PolicyRow[];
    principals: PrincipalOption[];
}) {
    const t = useTranslations("admin");
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
                    <CardTitle>{t("policies.create.title")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Input
                            placeholder={t("policies.create.name")}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                        />
                        <Input
                            placeholder={t("policies.create.description")}
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </div>
                    <JsonEditor
                        label={t("policies.create.document")}
                        className="max-h-96"
                        value={document}
                        onChange={setDocument}
                    />
                    <p className="text-xs text-muted-foreground">
                        {t.rich("policies.create.hint", {
                            code: (chunks) => <code key={String(chunks)}>{chunks}</code>
                        })}
                    </p>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div>
                        <Button onClick={onCreate} disabled={pending || !name.trim()}>
                            <Plus className="size-4" />
                            {t("policies.create.submit")}
                        </Button>
                    </div>
                </CardBody>
            </Card>

            {policies.length === 0 ? (
                <Card>
                    <CardBody className="p-8 text-center text-sm text-muted-foreground">
                        {t("policies.empty")}
                    </CardBody>
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
    const t = useTranslations("admin");
    const [open, setOpen] = useState(false);
    const [name, setName] = useState(policy.name);
    const [description, setDescription] = useState(policy.description ?? "");
    const [document, setDocument] = useState(() => prettyJson(policy.document));
    const [attach, setAttach] = useState("");
    const [error, setError] = useState<string | null>(null);

    /** Nothing to save while the editor still holds the stored policy. */
    const unchanged =
        name.trim() === policy.name &&
        description.trim() === (policy.description ?? "") &&
        document === prettyJson(policy.document);

    function onSave() {
        setError(null);
        onMutateSave();
    }
    function onMutateSave() {
        onMutate(async () => {
            const result = await updatePolicyAction(
                policy.id,
                name.trim(),
                description.trim(),
                document
            );
            if (result.error) setError(result.error);
        });
    }

    function onAttach() {
        if (!attach) return;
        const [type, id] = attach.split(":");
        onMutate(() =>
            attachPolicyAction(policy.id, type as PrincipalOption["type"], id as string)
        );
        setAttach("");
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <CardTitle className="flex items-center gap-2">
                            {policy.name}
                            {policy.isSystem ? <Badge>{t("policies.card.system")}</Badge> : null}
                        </CardTitle>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                            {summarize(policy.document, t)}
                        </p>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("policies.card.toggle")}
                            onClick={() => setOpen((value) => !value)}
                        >
                            <ChevronDown
                                className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
                            />
                        </Button>
                        {!policy.isSystem ? (
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t("policies.card.delete", { name: policy.name })}
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
                    <span className="text-xs text-muted-foreground">
                        {t("policies.card.attachedTo")}
                    </span>
                    {policy.attachments.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                            {t("policies.card.nobody")}
                        </span>
                    ) : (
                        policy.attachments.map((attachment) => (
                            <span
                                key={`${attachment.principalType}:${attachment.principalId}`}
                                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                            >
                                {attachment.label}
                                <button
                                    type="button"
                                    aria-label={t("policies.card.detach", {
                                        label: attachment.label
                                    })}
                                    disabled={disabled}
                                    onClick={() =>
                                        onMutate(() =>
                                            detachPolicyAction(
                                                policy.id,
                                                attachment.principalType,
                                                attachment.principalId
                                            )
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
                    <Select
                        className="flex-1"
                        value={attach}
                        onValueChange={setAttach}
                        placeholder={t("policies.card.attachPlaceholder")}
                        options={principals.map((principal) => ({
                            value: `${principal.type}:${principal.id}`,
                            label: principal.label
                        }))}
                    />
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled || !attach}
                        onClick={onAttach}
                    >
                        <Plus className="size-4" />
                        {t("policies.card.attach")}
                    </Button>
                </div>
                {/* People are found by name rather than listed - a deployment's
                    directory is no select. Picking one attaches at once, as the
                    chips above detach at once. */}
                <PeoplePicker
                    picked={[]}
                    label={t("policies.card.attachPerson")}
                    exclude={policy.attachments
                        .filter((attachment) => attachment.principalType === "user")
                        .map((attachment) => attachment.principalId)}
                    search={findPolicyPeopleAction}
                    onChange={(picked) => {
                        if (disabled) return;
                        for (const person of picked) {
                            onMutate(() => attachPolicyAction(policy.id, "user", person.id));
                        }
                    }}
                />

                {open ? (
                    <div className="flex flex-col gap-3 border-t border-border pt-3">
                        {!policy.isSystem ? (
                            <>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <Input
                                        value={name}
                                        onChange={(event) => setName(event.target.value)}
                                    />
                                    <Input
                                        placeholder={t("policies.card.description")}
                                        value={description}
                                        onChange={(event) => setDescription(event.target.value)}
                                    />
                                </div>
                                <JsonEditor
                                    label={t("policies.card.document", { name: policy.name })}
                                    className="max-h-96"
                                    value={document}
                                    onChange={setDocument}
                                />
                                {error ? <p className="text-sm text-danger">{error}</p> : null}
                                <div>
                                    <Button
                                        size="sm"
                                        disabled={disabled || unchanged}
                                        onClick={onSave}
                                    >
                                        {t("policies.card.save")}
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <JsonView
                                value={document}
                                label={t("policies.card.document", { name: policy.name })}
                                className="max-h-96"
                            />
                        )}
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}
