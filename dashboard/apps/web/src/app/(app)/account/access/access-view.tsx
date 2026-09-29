"use client";

/**
 * Access rules: the account's sign-in restrictions on top, the reusable groups
 * below. Both edit through the same dialog component, so a rule set looks and
 * behaves identically wherever it is written.
 *
 * The current address is shown next to the sign-in card because it is the one
 * piece of information that makes these rules safe to write - the server refuses
 * a change that would shut this address out, but seeing it first avoids the trip.
 */

import { useState } from "react";
import { namePlaces } from "@polaris/core";
import { useRouter } from "next/navigation";
import type { AccessGroupView } from "@polaris/auth";
import { useConfirm } from "@/components/confirm-dialog";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Globe, Pencil, Plus, Trash2 } from "lucide-react";
import {
    createAccessGroupAction,
    deleteAccessGroupAction,
    saveSignInRulesAction,
    updateAccessGroupAction
} from "./actions";
import {
    AccessRulesEditor,
    accessRulesAreEmpty,
    accessRulesEqual,
    EMPTY_ACCESS_RULES,
    type AccessRulesValue
} from "@/components/access-rules-editor";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** One-line summary of what a rule set restricts. */
function summarize(
    value: {
        allowedCidrs: string[];
        allowedCountries: string[];
        allowedContinents: string[];
        groupIds?: string[];
    },
    t: NamespaceTranslator<"account">
): string {
    const parts: string[] = [];
    if (value.groupIds?.length) parts.push(t("access.summary.groups", { count: value.groupIds.length }));
    if (value.allowedCidrs.length) {
        parts.push(t("access.summary.addresses", { count: value.allowedCidrs.length }));
    }
    const places = value.allowedCountries.length + value.allowedContinents.length;
    if (places) parts.push(t("access.summary.locations", { count: places }));
    // A list of counts, one per kind of rule.
    return parts.length > 0 ? parts.join(", ") : t("access.summary.none");
}

/**
 * The same rule set spelled out. A count is enough where a dialog can be opened
 * to see the entries; where there is none - the limits an administrator imposed -
 * "1 location" tells a user they are restricted without telling them to what,
 * which is the one thing they need in order to understand a refused sign-in.
 */
function spellOut(value: {
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
}): string {
    return [...value.allowedCidrs, ...namePlaces(value.allowedCountries, value.allowedContinents)].join(", ");
}

export function AccessView({
    groups,
    signInRules,
    currentIp,
    enforced
}: {
    groups: AccessGroupView[];
    signInRules: AccessRulesValue;
    currentIp: string | null;
    /** Limits an administrator set on the account, which it cannot edit away. */
    enforced: { allowedCidrs: string[]; allowedCountries: string[]; allowedContinents: string[] };
}) {
    const router = useRouter();
    const t = useTranslations("account");
    const [confirm, confirmElement] = useConfirm();
    const [signInOpen, setSignInOpen] = useState(false);
    const [groupDialog, setGroupDialog] = useState<{ mode: "create" } | { mode: "edit"; group: AccessGroupView } | null>(
        null
    );
    const [error, setError] = useState<string | null>(null);
    const enforcedSummary = accessRulesAreEmpty({ ...enforced, groupIds: [] }) ? null : spellOut(enforced);

    async function removeGroup(group: AccessGroupView) {
        const ok = await confirm({
            title: t("access.deleteTitle", { name: group.name }),
            description:
                group.apiKeyCount > 0 || group.appliedToSignIn ? t("access.deleteInUse") : t("access.deleteFinal"),
            confirmLabel: t("apiKeys.list.delete"),
            danger: true
        });
        if (!ok) return;
        const result = await deleteAccessGroupAction(group.id);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    return (
        <div className="flex flex-col gap-4">
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <Card>
                <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{t("access.signIn.title")}</h2>
                        <p className="text-xs text-muted-foreground">{summarize(signInRules, t)}</p>
                        {currentIp ? (
                            <p className="pt-1 text-xs text-muted-foreground">
                                {t.rich("access.connectingFrom", {
                                    ip: (chunks) => (
                                        <span key="ip" className="font-mono">
                                            {chunks}
                                        </span>
                                    ),
                                    address: currentIp
                                })}
                            </p>
                        ) : null}
                        {/* Not editable here, but a sign-in it refuses is otherwise
                            unexplainable from this page. */}
                        {enforcedSummary ? (
                            <p className="pt-1 text-xs text-warning">
                                {t("access.enforced", { rules: enforcedSummary })}
                            </p>
                        ) : null}
                    </div>
                    <Button onClick={() => setSignInOpen(true)}>
                        <Pencil className="size-4" />
                        {t("apiKeys.list.edit")}
                    </Button>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <div>
                            <h2 className="text-sm font-medium">{t("access.groups.title")}</h2>
                            <p className="text-xs text-muted-foreground">{t("access.groups.description")}</p>
                        </div>
                        <Button size="sm" onClick={() => setGroupDialog({ mode: "create" })}>
                            <Plus className="size-4" />
                            {t("access.groups.new")}
                        </Button>
                    </div>

                    {groups.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t("access.groups.empty")}
                        </p>
                    ) : (
                        groups.map((group) => (
                            <div
                                key={group.id}
                                className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <Globe className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0">
                                        <p className="flex items-center gap-2 text-sm">
                                            <span className="truncate">{group.name}</span>
                                            {group.appliedToSignIn ? <Badge variant="primary">{t("access.groups.signIn")}</Badge> : null}
                                            {group.apiKeyCount > 0 ? (
                                                <Badge>
                                                    {t("access.groups.keys", { count: group.apiKeyCount })}
                                                </Badge>
                                            ) : null}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {group.description || summarize(group, t)}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("apiKeys.list.editNamed", { name: group.name })}
                                        onClick={() => setGroupDialog({ mode: "edit", group })}
                                    >
                                        <Pencil className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("access.groups.deleteNamed", { name: group.name })}
                                        onClick={() => void removeGroup(group)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            </div>
                        ))
                    )}
                </CardBody>
            </Card>

            <SignInRulesDialog
                open={signInOpen}
                onOpenChange={setSignInOpen}
                groups={groups}
                initial={signInRules}
                onSaved={() => router.refresh()}
            />
            {groupDialog ? (
                <GroupDialog
                    open
                    onOpenChange={(open) => !open && setGroupDialog(null)}
                    group={groupDialog.mode === "edit" ? groupDialog.group : null}
                    onSaved={() => {
                        setGroupDialog(null);
                        router.refresh();
                    }}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

function SignInRulesDialog({
    open,
    onOpenChange,
    groups,
    initial,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    groups: AccessGroupView[];
    initial: AccessRulesValue;
    onSaved: () => void;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [value, setValue] = useState<AccessRulesValue>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
        setBusy(true);
        setError(null);
        const result = await saveSignInRulesAction(value);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        onSaved();
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) {
                    setValue(initial);
                    setError(null);
                }
            }}
        >
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("access.signIn.title")}</DialogTitle>
                    <DialogDescription>{t("access.signIn.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <AccessRulesEditor value={value} groups={groups} onChange={setValue} />
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    {accessRulesAreEmpty(value) ? (
                        <p className="text-xs text-muted-foreground">
                            {t("access.signIn.none")}
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={() => void save()} disabled={busy || accessRulesEqual(value, initial)}>
                            {busy ? tc("actions.saving") : tc("actions.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function GroupDialog({
    open,
    onOpenChange,
    group,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    group: AccessGroupView | null;
    onSaved: () => void;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [name, setName] = useState(group?.name ?? "");
    const [description, setDescription] = useState(group?.description ?? "");
    const [value, setValue] = useState<AccessRulesValue>(
        group
            ? {
                  groupIds: [],
                  allowedCidrs: group.allowedCidrs,
                  allowedCountries: group.allowedCountries,
                  allowedContinents: group.allowedContinents
              }
            : EMPTY_ACCESS_RULES
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Editing an existing group only offers Save once something actually differs. */
    const unchanged =
        group !== null &&
        name.trim() === group.name &&
        description.trim() === (group.description ?? "") &&
        accessRulesEqual(value, {
            groupIds: [],
            allowedCidrs: group.allowedCidrs,
            allowedCountries: group.allowedCountries,
            allowedContinents: group.allowedContinents
        });

    async function save() {
        setBusy(true);
        setError(null);
        const input = {
            name,
            description: description || undefined,
            allowedCidrs: value.allowedCidrs,
            allowedCountries: value.allowedCountries,
            allowedContinents: value.allowedContinents
        };
        const result = group
            ? await updateAccessGroupAction(group.id, input)
            : await createAccessGroupAction(input);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onSaved();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {group ? t("access.groups.editTitle", { name: group.name }) : t("access.groups.newTitle")}
                    </DialogTitle>
                    <DialogDescription>{t("access.groups.dialogDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("apiKeys.list.columns.name")}
                        <Input
                            value={name}
                            placeholder={t("access.groups.namePlaceholder")}
                            onChange={(event) => setName(event.target.value)}
                            autoComplete="off"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("apiKeys.form.description")}
                        <Input
                            value={description}
                            placeholder={t("access.groups.optional")}
                            onChange={(event) => setDescription(event.target.value)}
                            autoComplete="off"
                        />
                    </label>
                    <AccessRulesEditor value={value} groups={[]} onChange={setValue} showGroups={false} />
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={() => void save()} disabled={busy || name.trim() === "" || unchanged}>
                            {busy ? tc("actions.saving") : group ? t("apiKeys.form.saveChanges") : t("access.groups.create")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
