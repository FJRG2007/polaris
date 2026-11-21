"use client";

/**
 * The devices this account blocked from the sessions list, each with its
 * Unblock. Shown only when there is one: an empty card saying nothing is
 * blocked answers a question nobody arrived with.
 */

import { useState } from "react";
import { Ban } from "lucide-react";
import { useRouter } from "next/navigation";
import { unblockDeviceAction } from "./actions";
import { Button, Card, CardBody } from "@polaris/ui";
import { SystemMark } from "@/components/client-marks";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { BlockedDeviceView } from "@/lib/device-sessions/device-block";

export function BlockedDevicesCard({ devices }: { devices: readonly BlockedDeviceView[] }) {
    const t = useTranslations("accountSecurity");
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function unblock(device: BlockedDeviceView) {
        const ok = await confirm({
            title: t("sessions.blocked.unblockTitle", { device: device.label }),
            description: t("sessions.blocked.unblockDescription", { device: device.label }),
            confirmLabel: t("sessions.blocked.unblockConfirm")
        });
        if (!ok) return;
        setBusyId(device.id);
        setError(null);
        const result = await unblockDeviceAction(device.id);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{t("sessions.blocked.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("sessions.blocked.hint")}</p>
                </div>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {devices.map((device) => (
                        <li
                            key={device.id}
                            className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
                        >
                            <div className="flex min-w-0 items-center gap-3">
                                {device.os ? (
                                    <SystemMark os={device.os} />
                                ) : (
                                    <Ban aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                                )}
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium" title={device.label}>
                                        {device.label}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {device.os ? `${device.os} - ` : null}
                                        {t.rich("sessions.blocked.blockedAt", {
                                            time: () => <RelativeTime key="time" iso={device.createdAt} />
                                        })}
                                    </p>
                                </div>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                aria-label={t("sessions.blocked.unblockNamed", { device: device.label })}
                                disabled={busyId !== null}
                                onClick={() => void unblock(device)}
                            >
                                {t("sessions.blocked.unblock")}
                            </Button>
                        </li>
                    ))}
                </ul>
                {confirmElement}
            </CardBody>
        </Card>
    );
}
