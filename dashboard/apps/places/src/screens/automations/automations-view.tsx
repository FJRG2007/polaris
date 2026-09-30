"use client";

/**
 * The automations of a place: which are on, when each last ran and how it went,
 * and the two presses that matter without opening one - switch it off, run it
 * now.
 *
 * The switch is optimistic: it moves when pressed and moves back, with the
 * reason, if the server refused. The list paints from the last copy this tab
 * read while the fresh one is fetched, so coming back to the screen does not
 * start from a skeleton.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { History, Loader2, Play, Plus, Trash2, Workflow } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    Skeleton,
    Switch,
    cn
} from "@polaris/ui";
import { toneClass } from "../devices/device-panel";
import { automationsCacheKey, dropAutomationsCache } from "./cache";
import * as actions from "./actions";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import * as auto from "../../lib/automation-kinds";
import * as words from "../../lib/automation-words";
import type { DeviceView } from "../../lib/device-kinds";

const { runAction } = hostUi.runAction;
const { RelativeTime } = hostUi.relativeTime;
const { readSnapshot, writeSnapshot } = hostUi.snapshotCache;

/** How long a copy of the list is good for painting from. */
const CACHE_MS = 30_000;

interface Listing {
    readonly automations: auto.AutomationView[];
    readonly devices: DeviceView[];
}

export function AutomationsView({ placeId, canManage }: { placeId: string; canManage: boolean }) {
    const t = usePlacesT();
    const [listing, setListing] = useState<Listing | null>(null);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
    const [error, setError] = useState("");
    const [pending, setPending] = useState<Record<string, "toggle" | "run">>({});
    const [removing, setRemoving] = useState<auto.AutomationView | null>(null);
    const [ran, setRan] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const cached = readSnapshot<Listing>(automationsCacheKey(placeId), CACHE_MS);
        if (cached) setListing(cached.value);
        void (async () => {
            const result = await runAction(() => actions.listAutomationsAction(), setError);
            if (cancelled || !result) return;
            if (result.error) {
                setError(result.error);
                setListing((current) => current ?? { automations: [], devices: [] });
                return;
            }
            const next = { automations: result.automations ?? [], devices: result.devices ?? [] };
            setListing(next);
            writeSnapshot(automationsCacheKey(placeId), next);
        })();
        return () => {
            cancelled = true;
        };
    }, [placeId]);

    const lookup = useMemo<words.DeviceLookup>(() => {
        const byId = new Map((listing?.devices ?? []).map((device) => [device.id, device]));
        return (id) => byId.get(id);
    }, [listing]);

    const shown = useMemo(
        () => (listing ? listing.automations.filter((automation) => !hidden.has(automation.id)) : []),
        [listing, hidden]
    );

    const hide = (id: string, hiding: boolean) =>
        setHidden((current) => {
            const next = new Set(current);
            if (hiding) next.add(id);
            else next.delete(id);
            return next;
        });

    const replace = (automation: auto.AutomationView) =>
        setListing((current) =>
            current
                ? {
                      ...current,
                      automations: current.automations.map((entry) =>
                          entry.id === automation.id ? automation : entry
                      )
                  }
                : current
        );

    /** The row is no longer waiting on anything. */
    const settle = (id: string) =>
        setPending((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });

    const toggle = async (automation: auto.AutomationView, enabled: boolean) => {
        setError("");
        replace({ ...automation, enabled });
        setPending((current) => ({ ...current, [automation.id]: "toggle" }));
        const result = await runAction(() => actions.setAutomationEnabledAction(automation.id, enabled), setError);
        settle(automation.id);
        if (!result || result.error || !result.automation) {
            // Back to where it was, with the reason on the line above the list.
            setListing((current) =>
                current
                    ? {
                          ...current,
                          automations: current.automations.map((entry) =>
                              entry.id === automation.id ? { ...entry, enabled: automation.enabled } : entry
                          )
                      }
                    : current
            );
            if (result?.error) setError(result.error);
            return;
        }
        replace(result.automation);
        dropAutomationsCache();
    };

    const runNow = async (automation: auto.AutomationView) => {
        setError("");
        setRan(null);
        setPending((current) => ({ ...current, [automation.id]: "run" }));
        const result = await runAction(() => actions.runAutomationAction(automation.id), setError);
        settle(automation.id);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setRan(automation.id);
        dropAutomationsCache();
    };

    const remove = async () => {
        const target = removing;
        if (!target) return;
        setRemoving(null);
        hide(target.id, true);
        const result = await runAction(() => actions.deleteAutomationAction(target.id), setError);
        if (!result || result.error) {
            hide(target.id, false);
            if (result?.error) setError(result.error);
            return;
        }
        setListing((current) =>
            current
                ? { ...current, automations: current.automations.filter((entry) => entry.id !== target.id) }
                : current
        );
        hide(target.id, false);
        dropAutomationsCache();
    };

    const newMenu = canManage ? (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm">
                    <Plus className="size-4 shrink-0" />
                    {t("automations.list.new")}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                    <Link href="/places/devices/automations/new">{t("automations.list.blank")}</Link>
                </DropdownMenuItem>
                {auto.TEMPLATES.map((template) => (
                    <DropdownMenuItem key={template} asChild>
                        <Link href={`/places/devices/automations/new?template=${template}`}>
                            {t(`automations.templates.${template}.title`)}
                        </Link>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    ) : null;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("automations.list.intro")}</p>
                {newMenu}
            </div>

            {error && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            )}

            {listing === null ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                </div>
            ) : shown.length === 0 ? (
                <EmptyState
                    icon={<Workflow className="size-5" />}
                    title={t("automations.list.emptyTitle")}
                    description={canManage ? t("automations.list.emptyManage") : t("automations.list.emptyView")}
                    action={newMenu ?? undefined}
                />
            ) : (
                <ul className="flex flex-col gap-2">
                    {shown.map((automation) => {
                        const busy = pending[automation.id];
                        const firstTrigger = automation.definition.triggers[0];
                        return (
                            <li
                                key={automation.id}
                                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3"
                            >
                                <Switch
                                    checked={automation.enabled}
                                    disabled={!canManage || busy === "toggle"}
                                    onChange={(next) => void toggle(automation, next)}
                                    aria-label={
                                        automation.enabled
                                            ? t("automations.list.turnOffName", { name: automation.name })
                                            : t("automations.list.turnOnName", { name: automation.name })
                                    }
                                />
                                <Link
                                    href={`/places/devices/automations/${automation.id}`}
                                    className="flex min-w-0 flex-1 flex-col gap-0.5"
                                >
                                    <span
                                        className={cn(
                                            "truncate text-sm font-medium",
                                            !automation.enabled && "text-muted-foreground"
                                        )}
                                        title={automation.name}
                                    >
                                        {automation.name}
                                    </span>
                                    <span className="truncate text-[0.6875rem] text-foreground-subtle">
                                        {firstTrigger
                                            ? t("automations.list.summary", {
                                                  when: words.describeTrigger(firstTrigger, lookup, t),
                                                  more: automation.definition.triggers.length - 1,
                                                  steps: automation.definition.actions.length
                                              })
                                            : ""}
                                    </span>
                                </Link>
                                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                    {automation.lastStatus ? (
                                        <>
                                            <Badge className={toneClass(words.RUN_TONES[automation.lastStatus])}>
                                                {words.runStatusText(automation.lastStatus, t)}
                                            </Badge>
                                            {automation.lastRunAt && <RelativeTime iso={automation.lastRunAt} />}
                                        </>
                                    ) : (
                                        t("automations.list.neverRan")
                                    )}
                                </span>
                                <span className="flex shrink-0 items-center gap-1">
                                    {ran === automation.id && (
                                        <span className="text-xs text-muted-foreground" role="status">
                                            {t("automations.list.started")}
                                        </span>
                                    )}
                                    <Button
                                        asChild
                                        size="sm"
                                        variant="ghost"
                                        className="size-8 p-0"
                                        aria-label={t("automations.list.logName", { name: automation.name })}
                                        title={t("automations.list.log")}
                                    >
                                        <Link href={`/places/devices/automations/${automation.id}?tab=runs`}>
                                            <History className="size-4" />
                                        </Link>
                                    </Button>
                                    {canManage && (
                                        <>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="size-8 p-0"
                                                disabled={busy === "run" || !automation.enabled}
                                                aria-label={t("automations.list.runName", { name: automation.name })}
                                                title={
                                                    automation.enabled
                                                        ? t("automations.list.run")
                                                        : t("automations.list.runOff")
                                                }
                                                onClick={() => void runNow(automation)}
                                            >
                                                {busy === "run" ? (
                                                    <Loader2 className="size-4 animate-spin" />
                                                ) : (
                                                    <Play className="size-4" />
                                                )}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="size-8 p-0"
                                                aria-label={t("automations.list.removeName", { name: automation.name })}
                                                title={t("automations.list.remove")}
                                                onClick={() => setRemoving(automation)}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </>
                                    )}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (open ? undefined : setRemoving(null))}
                name={removing?.name ?? ""}
                kind="automation"
                requireTyping={false}
                title={t("automations.list.removeTitle")}
                question={t("automations.list.removeQuestion", { name: removing?.name ?? "" })}
                description={t("automations.list.removeBody")}
                confirmLabel={t("automations.list.remove")}
                onConfirm={() => void remove()}
            />
        </div>
    );
}
