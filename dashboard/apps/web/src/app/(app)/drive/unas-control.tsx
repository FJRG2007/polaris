"use client";

/**
 * What can be changed on a UniFi UNAS from here: its native fan profile and its
 * backup tasks, each of which can be started now. Read from the console through
 * the same stored account as the metrics; only somebody who manages
 * connections is offered the controls, everyone else sees the state.
 */

import { useState } from "react";
import { Fan, Play, RefreshCw } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { runUnasBackupAction, setUnasFanProfileAction } from "./actions";
import type { UnasBackupTask, UnasFanProfile } from "@/lib/unifi-unas-control";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    SegmentedControl,
    Skeleton,
    useToast
} from "@polaris/ui";

/** Fans and backups change rarely, and a run is reflected on the next read. */
const CONTROL_POLL_MS = 60_000;

interface ControlTask extends UnasBackupTask {
    readonly failed: boolean;
    readonly overdue: boolean;
}

interface UnasControlData {
    readonly fanProfile: UnasFanProfile | null;
    readonly tasks: ControlTask[] | null;
}

const FAN_LABEL = {
    quiet: "unasControl.fanQuiet",
    balanced: "unasControl.fanBalanced",
    cooling: "unasControl.fanCooling"
} as const satisfies Record<UnasFanProfile, string>;

export function UnasControl({
    connectionId,
    canManage
}: {
    connectionId: string;
    canManage: boolean;
}) {
    const t = useTranslations("drive");
    const format = useDisplayFormat();
    const toast = useToast();
    const [starting, setStarting] = useState<string | null>(null);
    const { data, loading, error, kept, replace, refresh } = useLiveResource<UnasControlData>({
        url: `/api/drive/unas-control?c=${encodeURIComponent(connectionId)}`,
        cacheKey: `unas-control.${connectionId}`,
        intervalMs: CONTROL_POLL_MS,
        select: (body) => body as UnasControlData
    });
    const mayAct = canManage && !kept;

    async function setFan(profile: UnasFanProfile): Promise<void> {
        if (!data || data.fanProfile === profile) return;
        const before = data;
        replace({ ...data, fanProfile: profile });
        const result = await setUnasFanProfileAction(connectionId, profile).catch(() => ({
            error: t("unasControl.fanFailed")
        }));
        if (result.error) {
            replace(before);
            toast.show({ title: t("unasControl.fanFailed"), body: result.error });
            return;
        }
        toast.show({ title: t("unasControl.fanSaved", { profile: t(FAN_LABEL[profile]) }) });
    }

    async function run(task: ControlTask): Promise<void> {
        setStarting(task.id);
        const result = await runUnasBackupAction(connectionId, task.id).catch(() => ({
            error: t("unasControl.runFailed")
        }));
        setStarting(null);
        if (result.error) {
            toast.show({ title: t("unasControl.runFailed"), body: result.error });
            return;
        }
        toast.show({ title: t("unasControl.runStarted", { name: task.name }) });
        refresh();
    }

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Fan className="size-4 text-muted-foreground" />
                        {t("unasControl.fans")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-2">
                    {loading ? (
                        <Skeleton className="h-8 w-64 max-w-full" />
                    ) : error ? (
                        <p className="text-sm text-muted-foreground">{error}</p>
                    ) : data?.fanProfile ? (
                        <>
                            <SegmentedControl<UnasFanProfile>
                                aria-label={t("unasControl.fanProfile")}
                                value={data.fanProfile}
                                onValueChange={(profile) => void setFan(profile)}
                                options={(Object.keys(FAN_LABEL) as UnasFanProfile[]).map(
                                    (value) => ({
                                        value,
                                        label: t(FAN_LABEL[value]),
                                        disabled: !mayAct
                                    })
                                )}
                            />
                            {!canManage ? (
                                <p className="text-xs text-muted-foreground">
                                    {t("unasControl.managedByAdmins")}
                                </p>
                            ) : null}
                        </>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            {t("unasControl.fanUnknown")}
                        </p>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("unasControl.backups")}</CardTitle>
                </CardHeader>
                <CardBody>
                    {loading ? (
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-10" />
                            <Skeleton className="h-10" />
                        </div>
                    ) : error ? (
                        <p className="text-sm text-muted-foreground">{error}</p>
                    ) : data?.tasks === null || data?.tasks === undefined ? (
                        <p className="text-sm text-muted-foreground">
                            {t("unasControl.backupsUnavailable")}
                        </p>
                    ) : data.tasks.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t("unasControl.noBackups")}
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {data.tasks.map((task) => {
                                const busy =
                                    starting === task.id ||
                                    task.lastStatus === "pending" ||
                                    task.lastStatus === "in-progress";
                                return (
                                    <li
                                        key={task.id}
                                        className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                                    >
                                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                            <span className="flex min-w-0 items-center gap-2 text-sm">
                                                <span
                                                    className="truncate font-medium"
                                                    title={task.name}
                                                >
                                                    {task.name}
                                                </span>
                                                {busy ? (
                                                    <Badge variant="neutral">
                                                        {t("unasControl.running")}
                                                    </Badge>
                                                ) : task.failed ? (
                                                    <Badge variant="danger">
                                                        {t("unasControl.failed")}
                                                    </Badge>
                                                ) : task.overdue ? (
                                                    <Badge variant="warning">
                                                        {t("unasControl.overdue")}
                                                    </Badge>
                                                ) : null}
                                            </span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                {task.lastFinishedAt
                                                    ? t("unasControl.lastRun", {
                                                          time: format.dateTime(task.lastFinishedAt)
                                                      })
                                                    : t("unasControl.neverRun")}
                                                {" - "}
                                                {task.scheduleEnabled && task.nextRun
                                                    ? t("unasControl.nextRun", {
                                                          time: format.dateTime(task.nextRun)
                                                      })
                                                    : t("unasControl.manualOnly")}
                                            </span>
                                        </div>
                                        {canManage ? (
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                aria-label={t("unasControl.run", {
                                                    name: task.name
                                                })}
                                                title={t("unasControl.run", { name: task.name })}
                                                disabled={!mayAct || busy}
                                                onClick={() => void run(task)}
                                            >
                                                {starting === task.id ? (
                                                    <RefreshCw className="size-4 animate-spin" />
                                                ) : (
                                                    <Play className="size-4" />
                                                )}
                                            </Button>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
