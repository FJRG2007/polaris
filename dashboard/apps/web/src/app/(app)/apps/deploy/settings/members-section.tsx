"use client";

/**
 * Access: who can reach this project, to do what, where, and until when.
 *
 * The owner is rendered in and marked, but is not an entry and cannot be removed
 * - a list that does not show who owns the thing reads as if nobody does.
 *
 * Everything else is one entry per principal. A role covers the normal case in
 * one click; the things a role cannot say - "deploy it but never read the
 * variables", "development and not production", "until the end of the month" -
 * are the three controls beside it, and they are only shown when they are being
 * used, so the simple case stays one field and a button.
 */

import { SettingsCard } from "../project-settings";
import { useDisplayFormat } from "@/components/display-format";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { ProjectAccessCandidates, ProjectMemberView } from "@/lib/deploy-project-service";
import { Building2, Clock, Crown, Globe2, Loader2, Pencil, UserPlus, Users } from "lucide-react";
import {
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import {
    listProjectMembersAction,
    projectAccessCandidatesAction,
    projectSettingsAction,
    removeProjectMemberAction,
    setProjectAccessAction
} from "../project-actions";
import {
    expandProjectCapabilities,
    PROJECT_CAPABILITY_AREAS,
    PROJECT_CAPABILITY_META,
    PROJECT_CAPABILITIES,
    PROJECT_PRINCIPAL_LABELS,
    PROJECT_PRINCIPALS,
    PROJECT_ROLES,
    PROJECT_ROLE_CAPABILITIES,
    PROJECT_ROLE_HINTS,
    PROJECT_ROLE_LABELS,
    type ProjectCapability,
    type ProjectPrincipalKind,
    type ProjectRole
} from "@polaris/core";

/** The role picker, plus the answer for access a role cannot describe. A role
 *  reaching past what the reader holds themselves is not offered: an entry never
 *  grants more than the person writing it can do, so the server would refuse it. */
function roleOptions(grantable: readonly ProjectCapability[]): { value: string; label: string }[] {
    const held = new Set(grantable);
    return [
        ...PROJECT_ROLES.filter((role) =>
            expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES[role]).every((capability) =>
                held.has(capability)
            )
        ).map((value) => ({ value, label: PROJECT_ROLE_LABELS[value] })),
        { value: "custom", label: "Custom" }
    ];
}

const PRINCIPAL_OPTIONS = PROJECT_PRINCIPALS.map((value) => ({
    value,
    label: PROJECT_PRINCIPAL_LABELS[value]
}));

/** How long an entry lasts. Offered as durations rather than a date field: the
 *  question people are answering is "for how long", and a date picker makes them
 *  do the arithmetic themselves. */
const EXPIRY_OPTIONS = [
    { value: "never", label: "No expiry" },
    { value: "7", label: "7 days" },
    { value: "30", label: "30 days" },
    { value: "90", label: "90 days" },
    { value: "365", label: "1 year" }
];

const PRINCIPAL_ICONS: Record<ProjectPrincipalKind, typeof Users> = {
    user: UserPlus,
    team: Users,
    org: Building2,
    everyone: Globe2
};

interface Environment {
    id: string;
    name: string;
}

/** What the editor holds while it is open. */
interface Draft {
    /** The entry being changed, or null when one is being written. */
    entryId: string | null;
    principal: ProjectPrincipalKind;
    principalId: string;
    identifier: string;
    role: ProjectRole | "custom";
    capabilities: ProjectCapability[];
    environmentIds: string[];
    expiry: string;
}

function emptyDraft(grantable: readonly ProjectCapability[]): Draft {
    const held = new Set(grantable);
    const role = expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.developer).every((capability) =>
        held.has(capability)
    )
        ? "developer"
        : "viewer";
    return {
        entryId: null,
        principal: "user",
        principalId: "",
        identifier: "",
        role,
        capabilities: expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES[role]),
        environmentIds: [],
        expiry: "never"
    };
}

function draftFrom(entry: ProjectMemberView): Draft {
    return {
        entryId: entry.id,
        principal: entry.principal,
        principalId: entry.principalId ?? "",
        identifier: "",
        role: entry.role,
        capabilities: entry.capabilities,
        environmentIds: entry.environmentIds ?? [],
        // An entry that already has a date keeps it until the editor is told
        // otherwise, so reopening one to change a capability does not silently
        // make it permanent.
        expiry: entry.expiresAt ? "keep" : "never"
    };
}

/** The date an expiry choice lands on, or null for one that never lapses. */
function expiresAt(choice: string, existing: string | null): string | null {
    if (choice === "keep") return existing;
    if (choice === "never") return null;
    const days = Number(choice);
    return Number.isFinite(days) ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
}

export function MembersSection({ projectId }: { projectId: string }) {
    const display = useDisplayFormat();
    const [members, setMembers] = useState<ProjectMemberView[] | null>(null);
    const [environments, setEnvironments] = useState<Environment[]>([]);
    const [candidates, setCandidates] = useState<ProjectAccessCandidates>({ orgs: [], teams: [] });
    const [canManage, setCanManage] = useState(false);
    /** What the reader may hand on, and where. The editor offers exactly this. */
    const [grantable, setGrantable] = useState<ProjectCapability[]>([]);
    const [grantableEnvironmentIds, setGrantableEnvironmentIds] = useState<string[] | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [removing, setRemoving] = useState<ProjectMemberView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function load() {
        void listProjectMembersAction(projectId).then((result) => {
            if (result.error) {
                setError(result.error);
                setMembers([]);
                return;
            }
            setMembers(result.members ?? []);
            setCanManage(result.canManage ?? false);
            setGrantable(result.grantable ?? []);
            setGrantableEnvironmentIds(result.grantableEnvironmentIds ?? null);
            if (result.canManage) {
                void projectAccessCandidatesAction(projectId).then((answer) => {
                    if (answer.candidates) setCandidates(answer.candidates);
                });
            }
        });
        // The environments are what an entry can be limited to, so the editor
        // needs them before it can offer the choice.
        void projectSettingsAction(projectId).then((result) => {
            setEnvironments(result.settings?.environments ?? []);
        });
    }

    useEffect(load, [projectId]);

    const byId = useMemo(() => new Map(environments.map((entry) => [entry.id, entry.name])), [environments]);

    function save() {
        if (!draft) return;
        setFormError(null);
        const existing = members?.find((entry) => entry.id === draft.entryId)?.expiresAt ?? null;
        startTransition(async () => {
            const result = await setProjectAccessAction({
                projectId,
                principal: draft.principal,
                principalId: draft.principalId || undefined,
                identifier: draft.identifier.trim() || undefined,
                role: draft.role === "custom" ? undefined : draft.role,
                capabilities: draft.role === "custom" ? draft.capabilities : undefined,
                environmentIds: draft.environmentIds,
                expiresAt: expiresAt(draft.expiry, existing)
            });
            if (result.error) {
                setFormError(result.error);
                return;
            }
            setDraft(null);
            load();
        });
    }

    function remove() {
        if (!removing) return;
        startTransition(async () => {
            const result = await removeProjectMemberAction({ projectId, memberId: removing.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setRemoving(null);
            load();
        });
    }

    /** The second line of a row: who they are, then whatever narrows the entry. */
    function summarize(entry: ProjectMemberView): string {
        const parts: string[] = [];
        if (entry.contact) parts.push(entry.contact);
        if (entry.isOwner) return parts.join(" - ");
        parts.push(entry.role === "custom" ? `${entry.capabilities.length} permissions` : PROJECT_ROLE_LABELS[entry.role]);
        if (entry.environmentIds) {
            const names = entry.environmentIds.map((id) => byId.get(id) ?? "removed environment");
            parts.push(names.length > 0 ? names.join(", ") : "no environment");
        }
        if (entry.expiresAt) {
            parts.push(entry.expired ? "expired" : `until ${display.date(entry.expiresAt)}`);
        }
        return parts.join(" - ");
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title="Access"
                description="Everyone here reaches this project through the same paths its owner does, limited to what their entry allows."
            >
                {error && <p className="text-sm text-danger">{error}</p>}

                <div className="overflow-hidden rounded-md border border-border/60">
                    {members === null ? (
                        <div className="flex justify-center py-6 text-muted-foreground">
                            <Loader2 className="size-5 animate-spin" />
                        </div>
                    ) : (
                        members.map((entry) => {
                            const Icon = PRINCIPAL_ICONS[entry.principal];
                            return (
                                <div
                                    key={entry.id}
                                    className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-0"
                                >
                                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="flex items-center gap-2 truncate text-sm font-medium">
                                                {entry.name}
                                                {entry.isOwner && (
                                                    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                                                        <Crown className="size-3" /> Owner
                                                    </span>
                                                )}
                                                {entry.expired && (
                                                    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-warning">
                                                        <Clock className="size-3" /> Expired
                                                    </span>
                                                )}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {summarize(entry)}
                                            </p>
                                        </div>
                                    </div>
                                    {canManage && !entry.isOwner && (
                                        <div className="flex shrink-0 items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                aria-label={`Change what ${entry.name} may do`}
                                                title="Edit"
                                                onClick={() => {
                                                    setFormError(null);
                                                    setDraft(draftFrom(entry));
                                                }}
                                            >
                                                <Pencil className="size-4" />
                                            </Button>
                                            <Button variant="ghost" size="sm" onClick={() => setRemoving(entry)}>
                                                Remove
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                {canManage && (
                    <div>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setFormError(null);
                                setDraft(emptyDraft(grantable));
                            }}
                        >
                            <UserPlus className="size-4" />
                            Give access
                        </Button>
                    </div>
                )}

                <dl className="flex flex-col gap-1">
                    {PROJECT_ROLES.map((entry) => (
                        <div key={entry} className="flex gap-2 text-xs">
                            <dt className="w-20 shrink-0 font-medium">{PROJECT_ROLE_LABELS[entry]}</dt>
                            <dd className="text-muted-foreground">{PROJECT_ROLE_HINTS[entry]}</dd>
                        </div>
                    ))}
                </dl>
            </SettingsCard>

            {draft && (
                <AccessDialog
                    draft={draft}
                    environments={environments.filter(
                        (environment) =>
                            grantableEnvironmentIds === null ||
                            grantableEnvironmentIds.includes(environment.id)
                    )}
                    grantable={grantable}
                    everyEnvironment={grantableEnvironmentIds === null}
                    candidates={candidates}
                    error={formError}
                    pending={pending}
                    onChange={setDraft}
                    onClose={() => setDraft(null)}
                    onSave={save}
                />
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                name={removing?.name ?? ""}
                kind="entry"
                confirmLabel="Remove access"
                description="They lose access to this project. Nothing they deployed is affected."
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}

/** The editor. One dialog for writing an entry and for changing one: they are the
 *  same write, and a second entry for the same principal would be a second answer
 *  to a question that has one. */
function AccessDialog({
    draft,
    environments,
    grantable,
    everyEnvironment,
    candidates,
    error,
    pending,
    onChange,
    onClose,
    onSave
}: {
    draft: Draft;
    /** Only the ones the reader reaches themselves - an entry cannot be given an
     *  environment its author cannot open. */
    environments: Environment[];
    grantable: readonly ProjectCapability[];
    /** False when the reader is themselves limited to some environments, in which
     *  case an entry has to name the ones it covers. */
    everyEnvironment: boolean;
    candidates: ProjectAccessCandidates;
    error: string | null;
    pending: boolean;
    onChange: (next: Draft) => void;
    onClose: () => void;
    onSave: () => void;
}) {
    const patch = (values: Partial<Draft>): void => onChange({ ...draft, ...values });

    /** Picking a role fills the checkboxes in, so switching to Custom starts from
     *  what was on screen rather than from nothing. */
    function pickRole(value: string): void {
        if (value === "custom") {
            patch({ role: "custom" });
            return;
        }
        const role = value as ProjectRole;
        patch({ role, capabilities: expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES[role]) });
    }

    function toggleCapability(capability: ProjectCapability, on: boolean): void {
        const held = new Set(draft.capabilities);
        if (on) held.add(capability);
        else held.delete(capability);
        // Expanded on the way in, the way the server stores it - so a box that is
        // ticked because another one implies it is ticked on screen too.
        patch({ role: "custom", capabilities: expandProjectCapabilities(held) });
    }

    function toggleEnvironment(id: string, on: boolean): void {
        patch({
            environmentIds: on
                ? [...draft.environmentIds, id]
                : draft.environmentIds.filter((entry) => entry !== id)
        });
    }

    const teamOptions = candidates.teams.map((team) => ({
        value: team.id,
        label: `${team.orgName} / ${team.name}`
    }));
    const orgOptions = candidates.orgs.map((org) => ({ value: org.id, label: org.name }));
    const named =
        draft.principal === "everyone" ||
        Boolean(draft.principalId) ||
        (draft.principal === "user" && draft.identifier.trim().length > 0);
    const ready = named && (everyEnvironment || draft.environmentIds.length > 0);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogTitle>{draft.entryId ? "Change access" : "Give access"}</DialogTitle>
                <div className="flex flex-col gap-4 pt-2">
                    {!draft.entryId && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">For</span>
                            <Select
                                value={draft.principal}
                                onValueChange={(value) =>
                                    patch({
                                        principal: value as ProjectPrincipalKind,
                                        principalId: "",
                                        identifier: ""
                                    })
                                }
                                options={PRINCIPAL_OPTIONS}
                                aria-label="Who this is for"
                            />
                        </label>
                    )}

                    {draft.principal === "user" && !draft.entryId && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                Email or username
                            </span>
                            <Input
                                value={draft.identifier}
                                onChange={(event) => patch({ identifier: event.target.value })}
                                placeholder="someone@example.com"
                                autoComplete="off"
                            />
                            <span className="text-xs text-muted-foreground">
                                They need an account on this Polaris already.
                            </span>
                        </label>
                    )}

                    {draft.principal === "team" && !draft.entryId && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">Team</span>
                            {teamOptions.length > 0 ? (
                                <Select
                                    value={draft.principalId}
                                    onValueChange={(value) => patch({ principalId: value })}
                                    options={teamOptions}
                                    aria-label="Team"
                                />
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    You are not on a team yet. Teams live inside an organization, under
                                    Account.
                                </span>
                            )}
                        </label>
                    )}

                    {draft.principal === "org" && !draft.entryId && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">Organization</span>
                            {orgOptions.length > 0 ? (
                                <Select
                                    value={draft.principalId}
                                    onValueChange={(value) => patch({ principalId: value })}
                                    options={orgOptions}
                                    aria-label="Organization"
                                />
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    You are not in an organization yet.
                                </span>
                            )}
                        </label>
                    )}

                    {draft.principal === "everyone" && !draft.entryId && (
                        <p className="text-xs text-muted-foreground">
                            Everyone with an account on this Polaris, whether or not they were added
                            here.
                        </p>
                    )}

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">They may</span>
                        <Select
                            value={draft.role}
                            onValueChange={pickRole}
                            options={roleOptions(grantable)}
                            aria-label="What they may do"
                        />
                    </label>

                    {draft.role === "custom" && (
                        <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
                            {PROJECT_CAPABILITY_AREAS.filter((area) =>
                                grantable.some(
                                    (capability) => PROJECT_CAPABILITY_META[capability].area === area
                                )
                            ).map((area) => (
                                <div key={area} className="flex flex-col gap-1.5">
                                    <p className="text-xs font-medium">{area}</p>
                                    {PROJECT_CAPABILITIES.filter(
                                        (capability) =>
                                            PROJECT_CAPABILITY_META[capability].area === area &&
                                            grantable.includes(capability)
                                    ).map((capability) => (
                                        <label key={capability} className="flex items-start gap-2 text-xs">
                                            <Checkbox
                                                checked={draft.capabilities.includes(capability)}
                                                onChange={(event) =>
                                                    toggleCapability(capability, event.target.checked)
                                                }
                                            />
                                            <span>
                                                {PROJECT_CAPABILITY_META[capability].label}
                                                {PROJECT_CAPABILITY_META[capability].hint && (
                                                    <span className="block text-muted-foreground">
                                                        {PROJECT_CAPABILITY_META[capability].hint}
                                                    </span>
                                                )}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Environments</span>
                        {everyEnvironment && (
                            <label className="flex items-center gap-2 text-xs">
                                <Checkbox
                                    checked={draft.environmentIds.length === 0}
                                    onChange={(event) =>
                                        patch({
                                            environmentIds: event.target.checked
                                                ? []
                                                : environments.slice(0, 1).map((entry) => entry.id)
                                        })
                                    }
                                />
                                Every environment
                            </label>
                        )}
                        {(!everyEnvironment || draft.environmentIds.length > 0) &&
                            environments.map((environment) => (
                                <label
                                    key={environment.id}
                                    className={`flex items-center gap-2 text-xs${everyEnvironment ? " pl-5" : ""}`}
                                >
                                    <Checkbox
                                        checked={draft.environmentIds.includes(environment.id)}
                                        onChange={(event) =>
                                            toggleEnvironment(environment.id, event.target.checked)
                                        }
                                    />
                                    {environment.name}
                                </label>
                            ))}
                    </div>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Expires</span>
                        <Select
                            value={draft.expiry}
                            onValueChange={(value) => patch({ expiry: value })}
                            options={
                                draft.expiry === "keep"
                                    ? [{ value: "keep", label: "Keep the current date" }, ...EXPIRY_OPTIONS]
                                    : EXPIRY_OPTIONS
                            }
                            aria-label="When this access ends"
                        />
                    </label>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button onClick={onSave} disabled={pending || !ready}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {draft.entryId ? "Save" : "Give access"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
