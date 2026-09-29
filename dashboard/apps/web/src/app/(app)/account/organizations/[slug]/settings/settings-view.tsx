"use client";

/**
 * Cards in the order the risk goes up: the photo, the profile, the handle, and
 * then the two things only an owner may do.
 *
 * Moving the handle is kept apart from a rename on purpose. A rename changes what
 * the organization is called; moving the handle breaks every link anybody saved,
 * so it is its own deliberate act with its own confirmation naming what stops
 * working.
 *
 * Not everybody who opens this sees all of it. The successor the owner named may
 * end the organization and change nothing about it, so for them the page is the
 * last card alone - showing them fields whose Save button would be refused is
 * worse than not showing them at all.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { OrgDeletionImpact, OrgDetail } from "@/lib/orgs/org-service";
import { useConfirm } from "@/components/confirm-dialog";
import { StepUpFields } from "@/components/step-up-fields";
import { OrgPicturesCard } from "@/app/(app)/account/avatar-card";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { orgValidationMessage } from "@/app/(app)/account/organizations/org-validation";
import { OrgSuccessorCard, type OrgSuccessorPerson } from "./successor-card";
import {
    changeOrgSlugAction,
    deleteOrgAction,
    setOrgChatAction,
    transferOrgAction,
    updateOrgAction
} from "@/app/(app)/account/organizations/actions";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    ConfirmDeleteDialog,
    Input,
    Select,
    Switch,
    Textarea
} from "@polaris/ui";

export function SettingsView({
    org,
    isOwner,
    canManage,
    canDelete,
    candidates,
    successor,
    impact,
    chatIsolated,
    chatOffered
}: {
    org: OrgDetail;
    isOwner: boolean;
    /** Holds `settings.manage`: the name, the photo and the handle. */
    canManage: boolean;
    /** The owner, the successor they named, or an instance administrator. Wider
     *  than `isOwner` on purpose: an organization whose owner has died is
     *  otherwise permanent. */
    canDelete: boolean;
    candidates: { userId: string; name: string }[];
    /** Who answers for this organization when its owner is gone - named here, or
     *  inherited from the owner's own account. Null for anybody but the owner,
     *  who is the only person shown or asked. */
    successor: OrgSuccessorPerson | null;
    impact: OrgDeletionImpact;
    /** Whether this organization keeps its own chat today. */
    chatIsolated: boolean;
    /** Whether this Polaris offers the choice at all. False hides nothing that
     *  was said - it only takes the switch away. */
    chatOffered: boolean;
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState("");

    const run = async (work: () => Promise<{ error?: string } | null>): Promise<boolean> => {
        setError("");
        const result = await runAction(work, setError);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return false;
        }
        router.refresh();
        return true;
    };

    return (
        <div className="flex flex-col gap-4">
            {error && (
                <p role="alert" className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm">
                    {error}
                </p>
            )}

            {canManage && (
                <>
                    <OrgPicturesCard
                        orgId={org.id}
                        name={org.name}
                        hasPhoto={org.hasPhoto}
                        hasBanner={org.hasBanner}
                    />
                    <ProfileCard org={org} onRun={run} />
                    <HandleCard org={org} confirm={confirm} onError={setError} />
                    {/* Under the handle because it is the one setting here that
                        changes what people see rather than what the
                        organization is called. */}
                    {chatOffered && (
                        <ChatCard orgId={org.id} isolated={chatIsolated} onRun={run} />
                    )}
                </>
            )}

            {/* Beside Transfer, because they are the two halves of the same
                question - who has this organization now, and who has it when
                you are gone - and both are the owner's alone. */}
            {isOwner && (
                <OrgSuccessorCard orgId={org.id} orgName={org.name} successor={successor} />
            )}
            {isOwner && (
                <TransferCard org={org} candidates={candidates} confirm={confirm} onRun={run} />
            )}
            {canDelete && <DangerCard org={org} impact={impact} />}
            {confirmElement}
        </div>
    );
}

/**
 * Its own chat, or the one everybody shares.
 *
 * Written as what it does to the people in it rather than as a feature, because
 * that is the decision: turning it on gives everybody here a second place their
 * messages can be, reached from the shelf switch in the header. Turning it back
 * off does not lose any of them.
 */
function ChatCard({
    orgId,
    isolated,
    onRun
}: {
    orgId: string;
    isolated: boolean;
    onRun: Runner;
}) {
    const t = useTranslations("accountOrgs");
    const [on, setOn] = useState(isolated);
    const [saving, setSaving] = useState(false);

    const change = async (next: boolean) => {
        if (saving) return;
        setSaving(true);
        // Moved first and put back if the write is refused: a switch that waits
        // for a round trip reads as a switch that did not take.
        setOn(next);
        const ok = await onRun(() => setOrgChatAction(orgId, next));
        setSaving(false);
        if (!ok) setOn(!next);
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("settings.chat.title")}</CardTitle>
            </CardHeader>
            <CardBody>
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("settings.chat.label")}</p>
                        <p className="text-muted-foreground text-xs">{t("settings.chat.hint")}</p>
                    </div>
                    <Switch
                        checked={on}
                        onChange={change}
                        disabled={saving}
                        aria-label={t("settings.chat.label")}
                    />
                </div>
            </CardBody>
        </Card>
    );
}

type Runner = (work: () => Promise<{ error?: string } | null>) => Promise<boolean>;
type Confirm = ReturnType<typeof useConfirm>[0];

function ProfileCard({ org, onRun }: { org: OrgDetail; onRun: Runner }) {
    const t = useTranslations("accountOrgs");
    const tv = useTranslations("validation");
    const [name, setName] = useState(org.name);
    const [description, setDescription] = useState(org.description);

    const parsed = core.organizationProfileSchema.safeParse({ name, description });
    // Dirty means the values differ from what was loaded, not that a field was
    // touched: something edited and put back leaves Save disabled.
    const changed = name !== org.name || description !== org.description;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("settings.profile.title")}</CardTitle>
            </CardHeader>
            <CardBody>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!parsed.success) return;
                        await onRun(() => updateOrgAction(org.id, parsed.data));
                    }}
                >
                    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                        {t("form.name")}
                        <Input value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                        {t("form.description")}
                        <Textarea
                            value={description}
                            rows={2}
                            placeholder={t("settings.profile.descriptionPlaceholder")}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </label>
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-danger text-xs">
                            {changed && !parsed.success
                                ? orgValidationMessage(t, tv, parsed.error.issues[0]?.message)
                                : ""}
                        </p>
                        <Button type="submit" size="sm" disabled={!changed || !parsed.success}>
                            {t("form.save")}
                        </Button>
                    </div>
                </form>
            </CardBody>
        </Card>
    );
}

function HandleCard({
    org,
    confirm,
    onError
}: {
    org: OrgDetail;
    confirm: Confirm;
    onError: (message: string) => void;
}) {
    const t = useTranslations("accountOrgs");
    const tv = useTranslations("validation");
    const router = useRouter();
    const [slug, setSlug] = useState(org.slug);

    const parsed = core.orgSlugField.safeParse(slug);
    const changed = slug !== org.slug;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("settings.handle.title")}</CardTitle>
            </CardHeader>
            <CardBody>
                <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!parsed.success || !changed) return;
                        const ok = await confirm({
                            title: t("settings.handle.confirmTitle"),
                            description: t("settings.handle.confirmBody", { slug: org.slug }),
                            confirmLabel: t("settings.handle.confirm")
                        });
                        if (!ok) return;
                        onError("");
                        const result = await runAction(
                            () => changeOrgSlugAction(org.id, slug),
                            onError
                        );
                        if (!result || result.error) {
                            if (result?.error) onError(result.error);
                            return;
                        }
                        // The URL this page lives at has just moved, so the page
                        // has to follow it rather than refresh into a 404.
                        router.replace(`/account/organizations/${result.slug}/settings`);
                    }}
                >
                    <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                        {t("form.handle")}
                        <Input
                            value={slug}
                            className="h-9"
                            onChange={(event) => setSlug(event.target.value)}
                        />
                    </label>
                    <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        disabled={!changed || !parsed.success}
                    >
                        {t("settings.handle.change")}
                    </Button>
                    <p className="text-muted-foreground w-full text-xs">
                        {changed && !parsed.success
                            ? orgValidationMessage(t, tv, parsed.error.issues[0]?.message)
                            : t("settings.handle.hint")}
                    </p>
                </form>
            </CardBody>
        </Card>
    );
}

function TransferCard({
    org,
    candidates,
    confirm,
    onRun
}: {
    org: OrgDetail;
    candidates: { userId: string; name: string }[];
    confirm: Confirm;
    onRun: Runner;
}) {
    const t = useTranslations("accountOrgs");
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("settings.transfer.title")}</CardTitle>
            </CardHeader>
            <CardBody>
                {candidates.length === 0 ? (
                    <p className="text-muted-foreground text-sm">{t("settings.transfer.nobody")}</p>
                ) : (
                    <label className="text-muted-foreground flex max-w-sm flex-col gap-1 text-xs">
                        {t("settings.transfer.to")}
                        <Select
                            value=""
                            className="h-9"
                            aria-label={t("settings.transfer.newOwner")}
                            placeholder={t("settings.transfer.choose")}
                            options={candidates.map((member) => ({
                                value: member.userId,
                                label: member.name
                            }))}
                            onValueChange={async (userId) => {
                                const person = candidates.find(
                                    (member) => member.userId === userId
                                );
                                const ok = await confirm({
                                    title: t("settings.transfer.confirmTitle", {
                                        org: org.name,
                                        name: person?.name ?? ""
                                    }),
                                    description: t("settings.transfer.confirmBody"),
                                    confirmLabel: t("settings.transfer.confirm")
                                });
                                if (ok) await onRun(() => transferOrgAction(org.id, userId));
                            }}
                        />
                    </label>
                )}
            </CardBody>
        </Card>
    );
}

/**
 * Ending the organization.
 *
 * Three tolls, and each one is there for a different mistake: the name has to be
 * typed, so a misclick cannot finish it; a second factor has to be answered, so
 * an open session somebody else is sitting at cannot either; and what is about
 * to be destroyed is counted out in the question rather than described as "this
 * organization", because the number of spaces and tasks is the part people are
 * wrong about.
 */
function DangerCard({ org, impact }: { org: OrgDetail; impact: OrgDeletionImpact }) {
    const t = useTranslations("accountOrgs");
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [proof, setProof] = useState<core.StepUpProofInput | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");

    const counts = { spaces: impact.spaces, tasks: impact.tasks };
    // Named in both places rather than counted: what is on a company's shelf is
    // a walk of a whole storage away, and that there is one going at all is the
    // part somebody about to press this is wrong about.
    const drive = impact.drive ? ` ${t("settings.danger.drive")}` : "";

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("settings.danger.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs">
                    {t("settings.danger.body", counts)}
                    {impact.projects > 0 && ` ${t("settings.danger.projects", { count: impact.projects })}`}
                    {drive}
                </p>
                <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                        setError("");
                        setOpen(true);
                    }}
                >
                    <Trash2 className="size-4 shrink-0" /> {t("settings.danger.button")}
                </Button>
            </CardBody>

            <ConfirmDeleteDialog
                open={open}
                onOpenChange={setOpen}
                name={org.name}
                kind="organization"
                confirmLabel={t("settings.danger.button")}
                error={error}
                pending={pending}
                confirmDisabled={proof === null}
                description={`${t("settings.danger.dialogBody", counts)}${drive} ${t("settings.danger.cannotUndo")}`}
                onConfirm={async () => {
                    if (!proof) return;
                    setPending(true);
                    setError("");
                    const result = await runAction(() => deleteOrgAction(org.id, proof), setError);
                    setPending(false);
                    if (!result || result.error) {
                        if (result?.error) setError(result.error);
                        return;
                    }
                    router.push("/account/organizations");
                }}
            >
                <StepUpFields open={open} purpose={`org-delete:${org.id}`} onChange={setProof} />
            </ConfirmDeleteDialog>
        </Card>
    );
}
