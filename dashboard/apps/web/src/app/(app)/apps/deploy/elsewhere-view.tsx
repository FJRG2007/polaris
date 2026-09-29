"use client";

/**
 * The board for the half of a project that runs somewhere else.
 *
 * One row per service, and the row carries what somebody came to see: whether the
 * last release worked, what commit it was, when, and the two links that matter -
 * the site itself and the provider's own page for the build. The one action on it
 * is releasing it again, because that is the only thing a control plane can
 * honestly offer for a service it does not build.
 *
 * What is deliberately absent is everything a Polaris service has and one of
 * these does not: no shell, no files, no volumes, no metrics, no log stream. Their
 * dashboard has all of that and Polaris cannot get at it, so the screen says
 * nothing rather than offering buttons that would explain themselves away.
 *
 * The rows refresh themselves while somebody is watching, because a build takes a
 * minute or two and the reason anybody presses deploy is to see what happens next.
 * Only while the tab is in front, and only while something is actually building.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { IntegrationLogo } from "@/components/logos";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as actions from "@/app/(app)/apps/deploy/external-actions";
import type { ProviderChoice } from "@/lib/deploy/providers/contract";
import type { ExternalServiceView } from "@/lib/deploy/external-services";
import { ExternalLink, HardDriveDownload, Loader2, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { MoveHomeDialog } from "@/app/(app)/apps/deploy/move-dialogs";
import {
    Badge,
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
    cn
} from "@polaris/ui";

/** How often a service that is mid-build is asked again. A build is minutes
 *  long, so this is about watching one finish rather than about keeping a board
 *  current - which is why nothing polls once everything has settled. */
const WATCH_MS = 15_000;

interface ProviderAccount {
    id: string;
    provider: string;
    label: string;
}

const STATUS_WORDS = {
    queued: "elsewhere.status.queued",
    building: "elsewhere.status.building",
    live: "elsewhere.status.live",
    failed: "elsewhere.status.failed",
    cancelled: "elsewhere.status.cancelled",
    unknown: "elsewhere.status.unknown"
} as const;

const STATUS_TONES: Readonly<Record<string, string>> = {
    queued: "border-border bg-muted text-muted-foreground",
    building: "border-accent/30 bg-accent/10 text-accent",
    live: "border-success-edge bg-success-soft text-success-ink",
    failed: "border-danger-edge bg-danger-soft text-danger-ink",
    cancelled: "border-warning-edge bg-warning-soft text-warning-ink",
    unknown: "border-border bg-muted text-muted-foreground"
};

/** Whether anything on the board is still moving, which is the only reason to
 *  keep asking. */
function anyBuilding(services: readonly ExternalServiceView[]): boolean {
    return services.some((service) => service.status === "queued" || service.status === "building");
}

export function ElsewhereView({
    projectId,
    services: initial,
    environments,
    accounts,
    canAdd,
    canDeploy,
    canRemove
}: {
    projectId: string;
    services: ExternalServiceView[];
    environments: { id: string; name: string }[];
    accounts: ProviderAccount[];
    canAdd: boolean;
    canDeploy: boolean;
    canRemove: boolean;
}) {
    const router = useRouter();
    const t = useTranslations("deploy");
    const format = useDisplayFormat();
    const [services, setServices] = useState(initial);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<ExternalServiceView | null>(null);
    const [bringing, setBringing] = useState<ExternalServiceView | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState("");

    const settle = useCallback((service: ExternalServiceView) => {
        setServices((current) => current.map((entry) => (entry.id === service.id ? service : entry)));
    }, []);

    const refresh = useCallback(
        async (id: string) => {
            const result = await actions.refreshExternalServiceAction(projectId, id);
            if (result.service) settle(result.service);
        },
        [projectId, settle]
    );

    const watching = useMemo(() => anyBuilding(services), [services]);

    useEffect(() => {
        if (!watching) return;
        const timer = setInterval(() => {
            if (document.visibilityState !== "visible") return;
            for (const service of services) {
                if (service.status === "queued" || service.status === "building") void refresh(service.id);
            }
        }, WATCH_MS);
        return () => clearInterval(timer);
    }, [watching, services, refresh]);

    const deploy = async (service: ExternalServiceView) => {
        setBusy(service.id);
        setError("");
        const result = await runAction(
            () => actions.deployExternalServiceAction(projectId, service.id),
            setError
        );
        setBusy(null);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.service) settle(result.service);
    };

    const remove = async () => {
        if (!removing) return;
        const result = await runAction(
            () => actions.removeExternalServiceAction(projectId, removing.id),
            setError
        );
        setRemoving(null);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setServices((current) => current.filter((entry) => entry.id !== removing.id));
        router.refresh();
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("elsewhere.title")}</h1>
                    <p className="text-sm text-muted-foreground">{t("elsewhere.intro")}</p>
                </div>
                {canAdd && accounts.length > 0 && (
                    <Button size="sm" onClick={() => setAdding(true)}>
                        <Plus className="size-4 shrink-0" />
                        {t("elsewhere.add")}
                    </Button>
                )}
            </div>

            {error && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            )}

            {accounts.length === 0 ? (
                <EmptyState
                    title={t("elsewhere.noAccount")}
                    description={t("elsewhere.noAccountHint")}
                    action={
                        <Button size="sm" asChild>
                            <Link href="/account/connections">{t("elsewhere.connectedAccounts")}</Link>
                        </Button>
                    }
                />
            ) : services.length === 0 ? (
                <EmptyState
                    title={t("elsewhere.empty")}
                    description={t("elsewhere.emptyHint")}
                    action={
                        canAdd ? (
                            <Button size="sm" onClick={() => setAdding(true)}>
                                <Plus className="size-4 shrink-0" />
                                {t("elsewhere.add")}
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <ul className="flex flex-col gap-2">
                    {services.map((service) => (
                        <li
                            key={service.id}
                            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3"
                        >
                            <IntegrationLogo
                                slug={service.provider}
                                className="size-5 w-6 shrink-0 object-contain text-muted-foreground"
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex flex-wrap items-center gap-2">
                                    <span className="truncate text-sm font-medium" title={service.name}>
                                        {service.name}
                                    </span>
                                    <Badge
                                        className={cn(
                                            "shrink-0",
                                            STATUS_TONES[service.status] ?? STATUS_TONES.unknown
                                        )}
                                    >
                                        {service.status === "building" && (
                                            <Loader2 className="size-3 shrink-0 animate-spin" />
                                        )}
                                        {t(STATUS_WORDS[service.status as keyof typeof STATUS_WORDS] ?? STATUS_WORDS.unknown)}
                                    </Badge>
                                </span>
                                <span
                                    className="truncate text-[0.6875rem] text-foreground-subtle"
                                    title={service.lastCommitMessage ?? undefined}
                                >
                                    {[
                                        service.account,
                                        service.lastCommitMessage,
                                        service.lastCommitSha ? service.lastCommitSha.slice(0, 7) : null,
                                        service.lastDeployAt ? format.dateTime(service.lastDeployAt) : null
                                    ]
                                        .filter(Boolean)
                                        .join(" - ")}
                                </span>
                                {service.error && (
                                    <span className="text-[0.6875rem] text-danger">{service.error}</span>
                                )}
                            </span>

                            <span className="flex flex-wrap items-center gap-2">
                                {service.url && (
                                    <Button size="sm" variant="outline" asChild>
                                        <Link href={service.url} target="_blank" rel="noreferrer">
                                            <ExternalLink className="size-4 shrink-0" />
                                            {t("elsewhere.open")}
                                        </Link>
                                    </Button>
                                )}
                                {service.inspectUrl && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={t("elsewhere.openOnProvider", { name: service.name })}
                                        title={t("elsewhere.openOnProviderTitle")}
                                        asChild
                                    >
                                        <Link href={service.inspectUrl} target="_blank" rel="noreferrer">
                                            <IntegrationLogo
                                                slug={service.provider}
                                                className="size-4 w-5 shrink-0 object-contain"
                                            />
                                        </Link>
                                    </Button>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("elsewhere.checkNamed", { name: service.name })}
                                    title={t("elsewhere.check")}
                                    onClick={() => void refresh(service.id)}
                                >
                                    <RefreshCw className="size-4 shrink-0" />
                                </Button>
                                {canDeploy && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy === service.id}
                                        onClick={() => void deploy(service)}
                                    >
                                        {busy === service.id ? (
                                            <Loader2 className="size-4 shrink-0 animate-spin" />
                                        ) : (
                                            <RotateCw className="size-4 shrink-0" />
                                        )}
                                        {t("elsewhere.deploy")}
                                    </Button>
                                )}
                                {canAdd && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={t("elsewhere.bringHomeNamed", { name: service.name })}
                                        title={t("elsewhere.bringHome")}
                                        onClick={() => setBringing(service)}
                                    >
                                        <HardDriveDownload className="size-4 shrink-0" />
                                    </Button>
                                )}
                                {canRemove && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={t("elsewhere.removeNamed", { name: service.name })}
                                        title={t("elsewhere.removeFromBoard")}
                                        onClick={() => setRemoving(service)}
                                    >
                                        <Trash2 className="size-4 shrink-0" />
                                    </Button>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {adding && (
                <AddDialog
                    projectId={projectId}
                    accounts={accounts}
                    environments={environments}
                    onClose={() => setAdding(false)}
                    onAdded={(service) => {
                        setServices((current) => [...current, service]);
                        setAdding(false);
                        router.refresh();
                    }}
                />
            )}

            {bringing && (
                <MoveHomeDialog
                    projectId={projectId}
                    service={bringing}
                    environments={environments}
                    onClose={() => setBringing(null)}
                    onMoved={() => router.refresh()}
                />
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (open ? undefined : setRemoving(null))}
                name={removing?.name ?? ""}
                kind={t("elsewhere.serviceKind")}
                requireTyping={false}
                description={t("elsewhere.removeDescription")}
                confirmLabel={t("elsewhere.remove")}
                onConfirm={remove}
            />
        </div>
    );
}

/**
 * Adding one: which account, which of its projects, and where it goes here.
 *
 * The provider's own list is fetched rather than typed into, because an id is not
 * something anybody has to hand - and a provider with a level below the project
 * asks for that too, which is what the second list is. Railway has one; Vercel
 * does not, and the field is simply absent for it rather than present and empty.
 */
function AddDialog({
    projectId,
    accounts,
    environments,
    onClose,
    onAdded
}: {
    projectId: string;
    accounts: ProviderAccount[];
    environments: { id: string; name: string }[];
    onClose: () => void;
    onAdded: (service: ExternalServiceView) => void;
}) {
    const t = useTranslations("deploy");
    const [account, setAccount] = useState(accounts[0]?.id ?? "");
    const [environment, setEnvironment] = useState(environments[0]?.id ?? "");
    const [choices, setChoices] = useState<ProviderChoice[] | null>(null);
    const [chosen, setChosen] = useState("");
    const [child, setChild] = useState("");
    const [name, setName] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

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

    const project = choices?.find((entry) => entry.id === chosen) ?? null;
    const children = project?.children ?? [];
    // Whether this one has a level below it, which the driver answers by handing
    // back children. It used to be "is this Railway", which is a sentence about
    // one provider living in a dialog - and the provider after it needed a second
    // one. What to store is on the choice itself now.
    const asksForChild = children.length > 0;
    const picked = asksForChild ? children.find((entry) => entry.id === child) : project;
    const ready = Boolean(account && environment && chosen && (!asksForChild || child) && name.trim());

    const submit = async () => {
        if (!ready || saving) return;
        setSaving(true);
        setError("");

        if (!picked?.externalId) {
            setSaving(false);
            setError(t("elsewhere.pickService"));
            return;
        }

        const result = await runAction(
            () =>
                actions.addExternalServiceAction(projectId, {
                    environmentId: environment,
                    connectionId: account,
                    name: name.trim(),
                    // What the driver said names this one. Nothing here knows the
                    // shape of it, which is the point.
                    externalId: picked.externalId,
                    ref: picked.ref ?? {}
                }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.service) onAdded(result.service);
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("elsewhere.addTitle")}</DialogTitle>
                    <DialogDescription>{t("elsewhere.addDescription")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">{t("move.out.account")}</span>
                        <Select
                            value={account}
                            onValueChange={setAccount}
                            options={accounts.map((entry) => ({
                                value: entry.id,
                                label: `${entry.label} (${entry.provider})`
                            }))}
                            aria-label={t("move.out.account")}
                        />
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                            {t("move.out.projectThere")}<span className="text-danger"> *</span>
                        </span>
                        {choices === null ? (
                            <Skeleton className="h-8 w-full" />
                        ) : choices.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                                {t("elsewhere.noProjects")}
                            </span>
                        ) : (
                            <Select
                                value={chosen}
                                onValueChange={(next) => {
                                    setChosen(next);
                                    setChild("");
                                    const picked = choices.find((entry) => entry.id === next);
                                    // Named after the thing being added, which is
                                    // what somebody would have typed anyway.
                                    if (picked && !name.trim()) setName(picked.name.split(" / ").at(-1) ?? "");
                                }}
                                options={choices.map((entry) => ({ value: entry.id, label: entry.name }))}
                                aria-label={t("move.out.projectThere")}
                            />
                        )}
                    </label>

                    {asksForChild && project && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">
                                {t("move.out.service")}<span className="text-danger"> *</span>
                            </span>
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
                        </label>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">
                                {t("move.home.nameHere")}<span className="text-danger"> *</span>
                            </span>
                            <Input
                                value={name}
                                maxLength={60}
                                onChange={(event) => setName(event.target.value)}
                                aria-label={t("move.home.nameHere")}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs text-muted-foreground">{t("move.home.environment")}</span>
                            <Select
                                value={environment}
                                onValueChange={setEnvironment}
                                options={environments.map((entry) => ({
                                    value: entry.id,
                                    label: entry.name
                                }))}
                                aria-label={t("move.home.environment")}
                            />
                        </label>
                    </div>

                    {error && (
                        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        {t("move.cancel")}
                    </Button>
                    <Button onClick={() => void submit()} disabled={!ready || saving} aria-disabled={!ready || saving}>
                        {saving && <Loader2 className="size-4 shrink-0 animate-spin" />}
                        {saving ? t("elsewhere.adding") : t("elsewhere.addButton")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
