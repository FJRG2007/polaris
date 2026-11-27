"use client";

/**
 * Syncing an environment with another one, as Railway's "Sync" does: pull the
 * other environment's changes into this one, or push this one's into it.
 *
 * The server reads both sides and answers every difference, service by
 * service, with why the reader may not apply one. Variables show their names
 * only. Domains never move, and a volume moves as a definition - an empty one
 * of its own on the receiving side. Removing a service is opt-in and goes to
 * the changeset for review rather than happening here.
 */

import * as polls from "../deploy-polls";
import { useRouter } from "next/navigation";
import type { EnvironmentNetworkMode, SyncItem } from "@polaris/core";
import { syncEnvironmentAction } from "../project-actions";
import type { SyncPreview } from "@/lib/deploy/environment-sync";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { ProjectEnvironmentView } from "@/lib/deploy-project-service";
import {
    Badge,
    Button,
    Checkbox,
    cn,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Select,
    settingType
} from "@polaris/ui";

type Direction = "pull" | "push";

type SyncEnvironment = Pick<ProjectEnvironmentView, "id" | "name" | "isDefault">;

export function SyncDialog({
    environments,
    environment,
    onClose
}: {
    /** The environments the reader may sync between. */
    environments: readonly SyncEnvironment[];
    /** The environment the dialog was opened from; null keeps it closed. */
    environment: SyncEnvironment | null;
    onClose: () => void;
}) {
    const t = useTranslations("deploySettings");
    const router = useRouter();
    const others = environments.filter((one) => one.id !== environment?.id);
    const [direction, setDirection] = useState<Direction>("pull");
    const [otherId, setOtherId] = useState("");
    const [preview, setPreview] = useState<{ preview: SyncPreview; canDeploy: boolean } | null>(
        null
    );
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [deployNow, setDeployNow] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [failures, setFailures] = useState<string[]>([]);
    const [version, setVersion] = useState(0);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        if (!environment) return;
        setDirection("pull");
        setOtherId(
            (others.find((one) => one.isDefault) ?? others[0])?.id ?? ""
        );
        setDeployNow(true);
        setError(null);
        setFailures([]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [environment?.id]);

    const sourceId = direction === "pull" ? otherId : (environment?.id ?? "");
    const targetId = direction === "pull" ? (environment?.id ?? "") : otherId;

    useEffect(() => {
        if (!environment || !sourceId || !targetId) return;
        const controller = new AbortController();
        setPreview(null);
        setError(null);
        void polls
            .syncPreview(
                { sourceEnvironmentId: sourceId, targetEnvironmentId: targetId },
                controller.signal
            )
            .then(
                (result) => {
                    if (controller.signal.aborted) return;
                    if (result.error || !result.preview) {
                        setError(result.error ?? t("sync.loadFailed"));
                        return;
                    }
                    const next = result.preview;
                    setPreview({ preview: next, canDeploy: result.canDeploy ?? false });
                    setPicked(
                        new Set(
                            next.diff.items
                                .filter((item) => item.recommended && !next.refusals[item.id])
                                .map((item) => item.id)
                        )
                    );
                },
                () => !controller.signal.aborted && setError(t("sync.loadFailed"))
            );
        return () => controller.abort();
    }, [environment, sourceId, targetId, version, t]);

    const groups = useMemo(() => {
        if (!preview) return [];
        const items = preview.preview.diff.items;
        const byService = preview.preview.diff.services.map((service) => ({
            key: service.slug,
            title: service.name,
            status: service.status,
            items: items.filter(
                (item) =>
                    item.service === service.slug &&
                    item.kind !== "shared.variable" &&
                    item.kind !== "network"
            )
        }));
        const environmentWide = items.filter(
            (item) => item.kind === "shared.variable" || item.kind === "network"
        );
        return environmentWide.length > 0
            ? [
                  ...byService,
                  {
                      key: "@environment",
                      title: t("sync.shared"),
                      status: null,
                      items: environmentWide
                  }
              ]
            : byService;
    }, [preview, t]);

    const other = others.find((one) => one.id === otherId) ?? null;
    const refusals = preview?.preview.refusals ?? {};
    const allowedIds =
        preview?.preview.diff.items.filter((item) => !refusals[item.id]).map((item) => item.id) ??
        [];
    const count = allowedIds.filter((id) => picked.has(id)).length;
    const blocked = !preview
        ? null
        : !preview.canDeploy
          ? t("sync.cannotDeploy")
          : preview.preview.diff.items.length === 0
            ? null
            : count === 0
              ? t("sync.pickSomething")
              : null;
    const ready = preview !== null && blocked === null && count > 0;

    function toggle(id: string, on: boolean) {
        setPicked((current) => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });
    }

    function submit() {
        if (!ready || !environment) return;
        setError(null);
        setFailures([]);
        startTransition(async () => {
            const result = await syncEnvironmentAction({
                sourceEnvironmentId: sourceId,
                targetEnvironmentId: targetId,
                items: allowedIds.filter((id) => picked.has(id)),
                mode: deployNow ? "deploy" : "stage"
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.failures && result.failures.length > 0) {
                // What went in stays in; what did not is offered again.
                setFailures(result.failures.map((failure) => failure.error));
                setPreview(null);
                setVersion((value) => value + 1);
                router.refresh();
                return;
            }
            onClose();
            router.refresh();
        });
    }

    function line(item: SyncItem): { label: string; detail: string | null } {
        if (item.kind === "service.add")
            return {
                label: t("sync.lines.add"),
                detail: t("sync.lines.addDetail", {
                    variables: item.carries?.variables ?? 0,
                    volumes: item.carries?.volumes ?? 0
                })
            };
        if (item.kind === "service.remove")
            return { label: t("sync.lines.remove"), detail: t("sync.lines.removeDetail") };
        if (item.kind === "service.setting" && item.field)
            return {
                label: t(`sync.fields.${item.field}`),
                detail: t("sync.lines.fromTo", {
                    from: item.from ?? t("sync.lines.unset"),
                    to: item.to ?? t("sync.lines.unset")
                })
            };
        if (item.kind === "volume")
            return {
                label: t("sync.lines.volume", { name: item.key ?? "" }),
                detail:
                    item.change === "added"
                        ? t("sync.lines.volumeAdded", { path: item.to ?? "" })
                        : t("sync.lines.fromTo", { from: item.from ?? "", to: item.to ?? "" })
            };
        if (item.kind === "network")
            return {
                label: t("sync.lines.network"),
                detail: t("sync.lines.fromTo", {
                    from: t(`sync.networkModes.${(item.from ?? "shared") as EnvironmentNetworkMode}`),
                    to: t(`sync.networkModes.${(item.to ?? "shared") as EnvironmentNetworkMode}`)
                })
            };
        return {
            label: item.key ?? "",
            detail: t(`sync.changes.${item.change}`) + (item.secret ? ` - ${t("sync.lines.hidden")}` : "")
        };
    }

    const statusTone = { new: "success", edited: "warning", removed: "danger" } as const;

    return (
        <Dialog open={environment !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("sync.title", { name: environment?.name ?? "" })}</DialogTitle>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
                        <div
                            role="group"
                            aria-label={t("sync.direction")}
                            className="flex shrink-0 gap-1"
                        >
                            {(["pull", "push"] as const).map((one) => (
                                <Button
                                    key={one}
                                    size="sm"
                                    variant={direction === one ? "secondary" : "ghost"}
                                    aria-pressed={direction === one}
                                    onClick={() => setDirection(one)}
                                >
                                    {t(`sync.${one}`)}
                                </Button>
                            ))}
                        </div>
                        <div className="min-w-0 flex-1">
                            <Select
                                value={otherId}
                                onValueChange={setOtherId}
                                aria-label={t(`sync.${direction}`)}
                                options={others.map((one) => ({ value: one.id, label: one.name }))}
                            />
                        </div>
                    </div>
                    <p className={settingType.hint}>
                        {direction === "pull"
                            ? t("sync.pullHint", {
                                  from: other?.name ?? "",
                                  to: environment?.name ?? ""
                              })
                            : t("sync.pushHint", {
                                  from: environment?.name ?? "",
                                  to: other?.name ?? ""
                              })}
                    </p>

                    {preview === null && !error ? (
                        <div className="flex flex-col gap-2" aria-hidden>
                            <div className="h-10 animate-pulse rounded-md bg-muted" />
                            <div className="h-10 animate-pulse rounded-md bg-muted" />
                        </div>
                    ) : preview && preview.preview.diff.items.length === 0 ? (
                        <p className={cn(settingType.body, "rounded-md border border-border/60 p-3 text-muted-foreground")}>
                            {t("sync.inSync", {
                                from: preview.preview.sourceName,
                                to: preview.preview.targetName
                            })}
                        </p>
                    ) : preview ? (
                        <div className="flex max-h-[50vh] min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain rounded-md border border-border/60 p-3">
                            <div className={cn(settingType.small, "flex flex-wrap gap-x-3 gap-y-1")}>
                                <button
                                    type="button"
                                    className="text-primary hover:underline"
                                    onClick={() => setPicked(new Set(allowedIds))}
                                >
                                    {t("sync.selectAll")}
                                </button>
                                <button
                                    type="button"
                                    className="text-primary hover:underline"
                                    onClick={() => setPicked(new Set())}
                                >
                                    {t("sync.selectNone")}
                                </button>
                            </div>
                            {groups.map((group) => (
                                <section key={group.key} className="flex min-w-0 flex-col gap-1.5">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <h3
                                            className={cn(settingType.body, "min-w-0 truncate font-medium")}
                                            title={group.title}
                                        >
                                            {group.title}
                                        </h3>
                                        {group.status && (
                                            <Badge variant={statusTone[group.status]}>
                                                {t(`sync.status.${group.status}`)}
                                            </Badge>
                                        )}
                                    </div>
                                    <ul className="flex min-w-0 flex-col gap-1.5">
                                        {group.items.map((item) => {
                                            const refusal = refusals[item.id];
                                            const { label, detail } = line(item);
                                            return (
                                                <li key={item.id} className="min-w-0">
                                                    <label className={cn(settingType.body, "flex min-w-0 items-start gap-2")}>
                                                        <Checkbox
                                                            checked={!refusal && picked.has(item.id)}
                                                            disabled={Boolean(refusal) || pending}
                                                            onChange={(event) =>
                                                                toggle(item.id, event.target.checked)
                                                            }
                                                            className="mt-0.5"
                                                        />
                                                        <span className="flex min-w-0 flex-col">
                                                            <span
                                                                className={`truncate ${item.change === "removed" ? "text-danger" : ""}`}
                                                                title={label}
                                                            >
                                                                {label}
                                                            </span>
                                                            {detail && (
                                                                <span
                                                                    className={cn(settingType.hint, "truncate")}
                                                                    title={detail}
                                                                >
                                                                    {detail}
                                                                </span>
                                                            )}
                                                            {refusal && (
                                                                <span className={settingType.hint}>
                                                                    {t(`sync.refusals.${refusal}`)}
                                                                </span>
                                                            )}
                                                        </span>
                                                    </label>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </section>
                            ))}
                            {preview.preview.diff.keptVolumes.length > 0 && (
                                <p className={settingType.hint}>
                                    {t("sync.keptVolumes", {
                                        names: preview.preview.diff.keptVolumes
                                            .map((volume) => `${volume.service}/${volume.name}`)
                                            .join(", ")
                                    })}
                                </p>
                            )}
                            <p className={settingType.hint}>{t("sync.notCopied")}</p>
                        </div>
                    ) : null}

                    {preview && preview.preview.diff.items.length > 0 && (
                        <label className={cn(settingType.body, "flex items-start gap-2")}>
                            <Checkbox
                                checked={deployNow}
                                onChange={(event) => setDeployNow(event.target.checked)}
                                className="mt-0.5"
                            />
                            <span className="min-w-0">
                                {t("sync.deployNow")}
                                <span className={cn(settingType.hint, "block")}>
                                    {deployNow ? t("sync.deployNowHint") : t("sync.stageHint")}
                                </span>
                            </span>
                        </label>
                    )}
                    {blocked && <p className={cn(settingType.body, "text-muted-foreground")}>{blocked}</p>}
                    {failures.length > 0 && (
                        <div className={cn(settingType.body, "text-danger")}>
                            <p>{t("sync.partly")}</p>
                            <ul className="list-disc ps-5">
                                {failures.map((failure, index) => (
                                    <li key={index} className="break-words">
                                        {failure}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {error && <p className={settingType.error}>{error}</p>}
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            {t("environments.cancel")}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={submit}
                            disabled={pending || !ready}
                            aria-disabled={!ready}
                        >
                            {deployNow
                                ? t("sync.apply", { count })
                                : t("sync.stage", { count })}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
