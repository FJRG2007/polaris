"use client";

/**
 * Moving a service between a Polaris server and a provider that builds its own.
 *
 * A project could already show both halves of itself - what Polaris runs and what
 * Vercel or Railway runs - and there was no way to get from one to the other.
 * Which left the ordinary thing anybody does with staging and production as the
 * one thing the board could not help with: two dashboards open, thirty variables
 * copied across by hand.
 *
 * Both dialogs say the same three things before they ask for anything, because
 * all three are ways somebody gets a surprise a day later:
 *
 * - **what travels** - the repository, the variables, the name;
 * - **what does not** - the volumes, the release history, the built image, since
 *   the far end builds its own;
 * - **what nobody here can move** - the domain, which points where DNS says it
 *   points, and that record is at a registrar Polaris may have no reach into.
 *
 * And nothing is deleted in either direction. Moving out stops the service here
 * and leaves everything it had; moving home leaves the provider's project running
 * and still on the board. Somebody who changes their mind puts it back with one
 * button, which is what makes a move worth offering at all.
 */

import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { CircleAlert, Loader2 } from "lucide-react";
import { IntegrationLogo } from "@/components/logos";
import * as actions from "@/app/(app)/apps/deploy/external-actions";
import type { MoveHomePlan, MoveOutPlan } from "@/lib/deploy/migrate";
import type { ProviderChoice } from "@/lib/deploy/providers/contract";
import type { ExternalServiceView } from "@/lib/deploy/external-services";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";

interface ProviderAccount {
    id: string;
    provider: string;
    label: string;
}

/** A line of the "before you do this" list. Drawn the same in both directions so
 *  the two read as one feature rather than two. */
function Note({ children }: { children: React.ReactNode }) {
    return (
        <li className="flex gap-2 text-xs text-muted-foreground">
            <span aria-hidden className="select-none text-foreground-subtle">
                -
            </span>
            <span className="min-w-0">{children}</span>
        </li>
    );
}

function Field({
    label,
    required,
    children
}: {
    label: string;
    required?: boolean;
    children: React.ReactNode;
}) {
    return (
        <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
                {label}
                {required && <span className="text-danger"> *</span>}
            </span>
            {children}
        </label>
    );
}

function Tick({
    label,
    hint,
    checked,
    onChange
}: {
    label: string;
    hint: string;
    checked: boolean;
    onChange: (next: boolean) => void;
}) {
    return (
        <label className="flex items-start gap-2.5 rounded-md border border-border p-3">
            <Checkbox
                checked={checked}
                className="mt-0.5"
                onChange={(event) => onChange(event.target.checked)}
            />
            <span className="min-w-0">
                <span className="block text-sm">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
            </span>
        </label>
    );
}

/**
 * What the dialog says about the variables, in the three cases there are.
 *
 * The names come back empty for somebody whose access does not include the
 * variables, and empty is not the same as none - so the count is what this reads
 * and the names only decorate it. Saying "there are no variables" to somebody who
 * simply may not see them would be the screen lying about the project.
 */
function variableNote(
    plan: { variableCount: number; variableKeys: readonly string[] },
    canCopy: boolean,
    t: NamespaceTranslator<"deploy">
): string {
    const count = plan.variableCount;
    if (count === 0) return t("move.variables.none");
    if (!canCopy) return t("move.variables.stay", { count });
    if (plan.variableKeys.length === 0) return t("move.variables.travel", { count });
    const listed = plan.variableKeys.slice(0, 6).join(", ");
    return plan.variableKeys.length > 6
        ? t("move.variables.travelListedMore", { count, names: listed })
        : t("move.variables.travelListed", { count, names: listed });
}

function Problem({ text }: { text: string }) {
    return (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
            {text}
        </p>
    );
}

/* -------------------------------------------------------------------------- */
/* Out of Polaris                                                             */
/* -------------------------------------------------------------------------- */

export function MoveOutDialog({
    projectId,
    application,
    onClose,
    onMoved
}: {
    projectId: string;
    application: { id: string; name: string; environmentId: string };
    onClose: () => void;
    onMoved: () => void;
}) {
    const t = useTranslations("deploy");
    const [plan, setPlan] = useState<MoveOutPlan | null>(null);
    const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
    const [account, setAccount] = useState("");
    const [choices, setChoices] = useState<ProviderChoice[] | null>(null);
    const [chosen, setChosen] = useState("");
    const [child, setChild] = useState("");
    const [name, setName] = useState(application.name);
    const [copyVariables, setCopyVariables] = useState(true);
    // Whether the variables are this person's to send at all. Decided on the
    // server and only mirrored here: withholding them is the point of a
    // capability set built without them, so the tick is not offered and the
    // names are not in the plan either.
    const [canCopy, setCanCopy] = useState(true);
    const [releaseThere, setReleaseThere] = useState(true);
    const [stopHere, setStopHere] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [planned, linked] = await Promise.all([
                actions.moveOutPlanAction(projectId, application.id),
                actions.listProviderAccountsAction()
            ]);
            if (cancelled) return;
            if (planned.error) setError(planned.error);
            if (planned.plan) setPlan(planned.plan);
            if (planned.canCopyVariables === false) {
                setCanCopy(false);
                setCopyVariables(false);
            }
            const found = linked.accounts ?? [];
            setAccounts(found);
            setAccount(found[0]?.id ?? "");
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId, application.id]);

    useEffect(() => {
        if (!account) return;
        let cancelled = false;
        setChoices(null);
        setChosen("");
        setChild("");
        void (async () => {
            const result = await actions.listProviderChoicesAction(account);
            if (cancelled) return;
            if (result.error) setError(result.error);
            setChoices(result.choices ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, [account]);

    const provider = accounts?.find((entry) => entry.id === account)?.provider ?? "";
    const project = choices?.find((entry) => entry.id === chosen) ?? null;
    const children = project?.children ?? [];
    // Railway's second level is a real choice - which service inside the project.
    // Vercel's is the team the project already lives in, which is not.
    const asksForChild = provider === "railway";
    const ready = Boolean(account && chosen && (!asksForChild || child) && name.trim());

    const submit = async () => {
        if (!ready || saving) return;
        setSaving(true);
        setError("");

        const picked = children.find((entry) => entry.id === child);
        const ref: Record<string, string> = {};
        if (asksForChild && picked) {
            ref.service = picked.id;
            const environmentOf = picked.children?.[0];
            if (environmentOf) ref.environment = environmentOf.id;
        } else if (children[0]) {
            ref.team = children[0].id;
        }

        const result = await runAction(
            () =>
                actions.moveOutAction(projectId, application.id, {
                    connectionId: account,
                    externalId: chosen,
                    ref,
                    name: name.trim(),
                    environmentId: application.environmentId,
                    copyVariables,
                    stopHere,
                    releaseThere
                }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        if (!result.result) return;
        const moved = result.result;
        setDone(
            [
                moved.copied > 0 ? t("move.out.copied", { count: moved.copied }) : t("move.out.noneCopied"),
                moved.stopped
                    ? t("move.out.stopped")
                    : moved.stopError
                      ? t("move.out.stillRunningError", { error: moved.stopError })
                      : t("move.out.stillRunning"),
                moved.domains.length > 0
                    ? t("move.out.domainsStay", { domains: moved.domains.join(", "), provider })
                    : ""
            ]
                .filter(Boolean)
                .join(" ")
        );
        onMoved();
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("move.out.title", { name: application.name })}</DialogTitle>
                    <DialogDescription>{t("move.out.description")}</DialogDescription>
                </DialogHeader>

                {done ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm">{done}</p>
                        <p className="text-xs text-muted-foreground">{t("move.out.doneHint")}</p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        {plan === null ? (
                            <Skeleton className="h-20 w-full" />
                        ) : (
                            <ul className="flex flex-col gap-1.5 rounded-md border border-border p-3">
                                <Note>
                                    {plan.repoUrl
                                        ? plan.branch
                                            ? t("move.out.builtFromBranch", { repo: plan.repoUrl, branch: plan.branch })
                                            : t("move.out.builtFrom", { repo: plan.repoUrl })
                                        : t("move.out.noRepo")}
                                </Note>
                                <Note>{variableNote(plan, canCopy, t)}</Note>
                                {plan.volumes.length > 0 && (
                                    <Note>
                                        {t("move.out.volumes", { volumes: plan.volumes.join(", ") })}
                                    </Note>
                                )}
                                {plan.domains.length > 0 && (
                                    <Note>
                                        {t("move.out.domains", { domains: plan.domains.join(", ") })}
                                    </Note>
                                )}
                            </ul>
                        )}

                        {accounts !== null && accounts.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                                {t("move.out.noAccount")}
                            </p>
                        )}

                        {accounts !== null && accounts.length > 0 && (
                            <>
                                <Field label={t("move.out.account")}>
                                    <Select
                                        value={account}
                                        onValueChange={setAccount}
                                        options={accounts.map((entry) => ({
                                            value: entry.id,
                                            label: `${entry.label} (${entry.provider})`
                                        }))}
                                        aria-label={t("move.out.account")}
                                    />
                                </Field>

                                <Field label={t("move.out.projectThere")} required>
                                    {choices === null ? (
                                        <Skeleton className="h-8 w-full" />
                                    ) : choices.length === 0 ? (
                                        <span className="text-xs text-muted-foreground">
                                            {t("move.out.noProjects")}
                                        </span>
                                    ) : (
                                        <Select
                                            value={chosen}
                                            onValueChange={(next) => {
                                                setChosen(next);
                                                setChild("");
                                            }}
                                            options={choices.map((entry) => ({
                                                value: entry.id,
                                                label: entry.name
                                            }))}
                                            aria-label={t("move.out.projectThere")}
                                        />
                                    )}
                                </Field>

                                {asksForChild && project && (
                                    <Field label={t("move.out.service")} required>
                                        {children.length === 0 ? (
                                            <span className="text-xs text-muted-foreground">
                                                {t("move.out.noServices")}
                                            </span>
                                        ) : (
                                            <Select
                                                value={child}
                                                onValueChange={setChild}
                                                options={children.map((entry) => ({
                                                    value: entry.id,
                                                    label: entry.name
                                                }))}
                                                aria-label={t("move.out.service")}
                                            />
                                        )}
                                    </Field>
                                )}

                                <Field label={t("move.out.nameOnBoard")} required>
                                    <Input
                                        value={name}
                                        maxLength={60}
                                        onChange={(event) => setName(event.target.value)}
                                        aria-label={t("move.out.nameOnBoard")}
                                    />
                                </Field>

                                <div className="flex flex-col gap-2">
                                    {canCopy && (
                                        <Tick
                                            label={t("move.out.copyVariables")}
                                            hint={t("move.out.copyVariablesHint")}
                                            checked={copyVariables}
                                            onChange={setCopyVariables}
                                        />
                                    )}
                                    <Tick
                                        label={t("move.out.buildNow")}
                                        hint={t("move.out.buildNowHint")}
                                        checked={releaseThere}
                                        onChange={setReleaseThere}
                                    />
                                    <Tick
                                        label={t("move.out.stopHere")}
                                        hint={t("move.out.stopHereHint")}
                                        checked={stopHere}
                                        onChange={setStopHere}
                                    />
                                </div>
                            </>
                        )}

                        {error && <Problem text={error} />}
                    </div>
                )}

                <DialogFooter>
                    {done ? (
                        <Button onClick={onClose}>{t("move.done")}</Button>
                    ) : (
                        <>
                            <Button variant="ghost" onClick={onClose} disabled={saving}>
                                {t("move.cancel")}
                            </Button>
                            <Button
                                onClick={() => void submit()}
                                disabled={!ready || saving}
                                aria-disabled={!ready || saving}
                            >
                                {saving && <Loader2 className="size-4 shrink-0 animate-spin" />}
                                {saving ? t("move.out.moving") : t("move.out.submit")}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* -------------------------------------------------------------------------- */
/* Into Polaris                                                               */
/* -------------------------------------------------------------------------- */

export function MoveHomeDialog({
    projectId,
    service,
    environments,
    onClose,
    onMoved
}: {
    projectId: string;
    service: ExternalServiceView;
    environments: { id: string; name: string }[];
    onClose: () => void;
    onMoved: () => void;
}) {
    const t = useTranslations("deploy");
    const [plan, setPlan] = useState<MoveHomePlan | null>(null);
    const [targets, setTargets] = useState<{ id: string; name: string }[]>([]);
    const [environment, setEnvironment] = useState(service.environmentId || environments[0]?.id || "");
    const [target, setTarget] = useState("");
    const [name, setName] = useState(service.name);
    const [repoUrl, setRepoUrl] = useState("");
    const [branch, setBranch] = useState("");
    const [copyVariables, setCopyVariables] = useState(true);
    // The same rule as the other direction, on the other capability: writing a
    // provider's values into this project's variables is a write of them.
    const [canCopy, setCanCopy] = useState(true);
    const [deployNow, setDeployNow] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await actions.moveHomePlanAction(projectId, service.id);
            if (cancelled) return;
            if (result.error) setError(result.error);
            if (result.canCopyVariables === false) {
                setCanCopy(false);
                setCopyVariables(false);
            }
            if (result.plan) {
                setPlan(result.plan);
                // Prefilled where the provider will say, asked for where it will
                // not - which is Railway, always, and Vercel for a project that
                // was deployed from somebody's command line.
                setRepoUrl(result.plan.source?.url ?? "");
                setBranch(result.plan.source?.branch ?? "");
            }
            const found = result.targets ?? [];
            setTargets(found);
            setTarget(found[0]?.id ?? "");
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId, service.id]);

    const ready = Boolean(environment && target && name.trim() && repoUrl.trim());

    const submit = async () => {
        if (!ready || saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.moveHomeAction(projectId, service.id, {
                    environmentId: environment,
                    targetId: target,
                    name: name.trim(),
                    repoUrl: repoUrl.trim(),
                    branch: branch.trim(),
                    copyVariables,
                    deployNow
                }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        if (!result.result) return;
        const moved = result.result;
        setDone(
            [
                moved.deploying ? t("move.home.building") : t("move.home.created"),
                moved.copied > 0 ? t("move.home.copied", { count: moved.copied }) : t("move.home.noneCopied"),
                moved.variablesError ?? ""
            ]
                .filter(Boolean)
                .join(" ")
        );
        onMoved();
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo
                            slug={service.provider}
                            className="size-4 w-5 shrink-0 object-contain"
                        />
                        {t("move.home.title", { name: service.name })}
                    </DialogTitle>
                    <DialogDescription>{t("move.home.description", { provider: service.provider })}</DialogDescription>
                </DialogHeader>

                {done ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm">{done}</p>
                        <p className="text-xs text-muted-foreground">
                            {t("move.home.doneHint", { name: service.name, provider: service.provider })}
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        {plan === null ? (
                            <Skeleton className="h-16 w-full" />
                        ) : (
                            <ul className="flex flex-col gap-1.5 rounded-md border border-border p-3">
                                <Note>
                                    {plan.source
                                        ? plan.source.branch
                                            ? t("move.home.buildsBranch", { repo: plan.source.repo, branch: plan.source.branch })
                                            : t("move.home.builds", { repo: plan.source.repo })
                                        : t("move.home.noSource", { provider: service.provider })}
                                </Note>
                                <Note>
                                    {plan.variablesError ?? variableNote(plan, canCopy, t)}
                                </Note>
                                <Note>
                                    {t("move.home.domains")}
                                </Note>
                            </ul>
                        )}

                        <Field label={t("move.home.repository")} required>
                            <Input
                                value={repoUrl}
                                maxLength={500}
                                // i18n-ignore: an example repository address
                                placeholder="https://github.com/owner/repo.git"
                                onChange={(event) => setRepoUrl(event.target.value)}
                                aria-label={t("move.home.repository")}
                            />
                        </Field>

                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label={t("move.home.branch")}>
                                <Input
                                    value={branch}
                                    maxLength={200}
                                    placeholder="main"
                                    onChange={(event) => setBranch(event.target.value)}
                                    aria-label={t("move.home.branch")}
                                />
                            </Field>
                            <Field label={t("move.home.nameHere")} required>
                                <Input
                                    value={name}
                                    maxLength={60}
                                    onChange={(event) => setName(event.target.value)}
                                    aria-label={t("move.home.nameHere")}
                                />
                            </Field>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label={t("move.home.server")} required>
                                {targets.length === 0 ? (
                                    <span className="text-xs text-muted-foreground">
                                        {t("move.home.noServer")}
                                    </span>
                                ) : (
                                    <Select
                                        value={target}
                                        onValueChange={setTarget}
                                        options={targets.map((entry) => ({
                                            value: entry.id,
                                            label: entry.name
                                        }))}
                                        aria-label={t("move.home.server")}
                                    />
                                )}
                            </Field>
                            <Field label={t("move.home.environment")}>
                                <Select
                                    value={environment}
                                    onValueChange={setEnvironment}
                                    options={environments.map((entry) => ({
                                        value: entry.id,
                                        label: entry.name
                                    }))}
                                    aria-label={t("move.home.environment")}
                                />
                            </Field>
                        </div>

                        <div className="flex flex-col gap-2">
                            {canCopy && (
                                <Tick
                                    label={t("move.home.copyVariables")}
                                    hint={t("move.home.copyVariablesHint")}
                                    checked={copyVariables}
                                    onChange={setCopyVariables}
                                />
                            )}
                            <Tick
                                label={t("move.home.buildNow")}
                                hint={t("move.home.buildNowHint")}
                                checked={deployNow}
                                onChange={setDeployNow}
                            />
                        </div>

                        {plan?.variablesError && (
                            <p className="flex items-start gap-2 text-xs text-warning">
                                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                {t("move.home.setByHand")}
                            </p>
                        )}

                        {error && <Problem text={error} />}
                    </div>
                )}

                <DialogFooter>
                    {done ? (
                        <Button onClick={onClose}>{t("move.done")}</Button>
                    ) : (
                        <>
                            <Button variant="ghost" onClick={onClose} disabled={saving}>
                                {t("move.cancel")}
                            </Button>
                            <Button
                                onClick={() => void submit()}
                                disabled={!ready || saving}
                                aria-disabled={!ready || saving}
                            >
                                {saving && <Loader2 className="size-4 shrink-0 animate-spin" />}
                                {saving ? t("move.home.settingUp") : t("move.home.submit")}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
