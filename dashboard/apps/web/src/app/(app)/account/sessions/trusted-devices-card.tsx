"use client";

/**
 * The browsers your account has stopped asking for a code.
 *
 * Ticking "remember this device" at the challenge buys that browser thirty days
 * of signing in on the password alone, and until now the account could only be
 * told how many such passes existed and offered to end every one of them. That
 * is the wrong control for the case it exists for: the phone that was left in a
 * taxi is one device, and ending its pass should not mean answering a code on
 * the laptop for the next month.
 *
 * So each pass is a row that can be ended on its own. The device labels come
 * from the user-agent the browser sent, exactly as in the session table above -
 * a hint, never a fact - which is why the address, the domain and the dates are
 * shown beside them: those are what somebody can actually recognise a device by.
 *
 * A pass granted before Polaris recorded any of that still appears, unnamed. A
 * device nobody can put a name to is the first one worth ending, not the one to
 * leave off the list.
 *
 * Opening a row is the other half of it. Ending a pass is not the only thing
 * somebody wants to do about a device they have recognised, and what else it can
 * reach - what it has signed in, what it holds a passkey for - is not something
 * a row has room for. The name opens that; the row keeps the one-click way to
 * end the pass, since that is the case this list exists for.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DeviceDialog } from "./device-dialog";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { Badge, Button, Card, CardBody, cn } from "@polaris/ui";
import type { TrustedDeviceRow } from "@/lib/session-directory";
import { addressLine, DeviceAddress } from "@/components/device-address";
import { forgetTrustedDeviceAction, forgetTrustedDevicesAction } from "./actions";
import { PanelRightOpen, ShieldOff, ShieldQuestion, Smartphone } from "lucide-react";

/** Where a pass was granted, as one line, for the layouts too narrow to hold the
 *  columns. */
function origin(device: TrustedDeviceRow): string {
    return [addressLine(device), device.host].filter(Boolean).join(" - ") || "Not recorded";
}

export function TrustedDevicesCard({ devices }: { devices: TrustedDeviceRow[] }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [opened, setOpened] = useState<TrustedDeviceRow | null>(null);

    async function forget(device: TrustedDeviceRow) {
        const ok = await confirm({
            title: "Ask this device for a code again?",
            description: `${device.device} will have to answer the challenge the next time it signs in.`,
            confirmLabel: "Forget it",
            danger: true
        });
        if (!ok) return;
        setBusyId(device.id);
        setError(null);
        const result = await forgetTrustedDeviceAction(device.id);
        setBusyId(null);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    async function forgetAll() {
        const ok = await confirm({
            title: "Forget every remembered device?",
            description: `${devices.length} device${devices.length === 1 ? "" : "s"} will be asked for a code again, this one included.`,
            confirmLabel: "Forget them all",
            danger: true
        });
        if (!ok) return;
        setBusyId("all");
        setError(null);
        await forgetTrustedDevicesAction();
        setBusyId(null);
        router.refresh();
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">Remembered devices</h2>
                        <p className="text-xs text-muted-foreground">
                            These sign in with the password alone until their 30 days run out.
                        </p>
                    </div>
                    {devices.length > 1 ? (
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId !== null}
                            onClick={() => void forgetAll()}
                        >
                            <ShieldOff className="size-4" />
                            Forget them all
                        </Button>
                    ) : null}
                </div>

                {error ? <p className="text-sm text-danger">{error}</p> : null}

                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                            {/* Each column waits for the width that holds it, and nothing
                                arrives at md: that is where the navigation rail appears, so
                                the content area is narrower there than a breakpoint
                                earlier. An early column scrolls the table sideways. */}
                            <tr>
                                {/* w-full max-w-0: the folded origin line under the name is
                                    nowrap, and without the cap it sets a floor under this
                                    column that spills the table sideways. */}
                                <th className="w-full max-w-0 px-3 py-2 font-medium">Device</th>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">Address</th>
                                <th className="hidden px-3 py-2 font-medium xl:table-cell">Domain</th>
                                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">Remembered</th>
                                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">Until</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {devices.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                                        Nothing is remembered. Every sign-in answers the challenge.
                                    </td>
                                </tr>
                            ) : (
                                devices.map((device) => {
                                    const named = device.rememberedAt !== null;
                                    return (
                                        <tr
                                            key={device.id}
                                            className={cn(
                                                "border-t border-border",
                                                busyId === device.id && "opacity-60"
                                            )}
                                        >
                                            <td className="w-full max-w-0 px-3 py-2">
                                                <div className="flex items-center gap-3">
                                                    {named ? (
                                                        <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                                                    ) : (
                                                        <ShieldQuestion className="size-4 shrink-0 text-muted-foreground" />
                                                    )}
                                                    <div className="min-w-0">
                                                        <p className="flex flex-wrap items-center gap-1.5">
                                                            <button
                                                                type="button"
                                                                className="min-w-0 truncate text-left hover:underline"
                                                                onClick={() => setOpened(device)}
                                                            >
                                                                {named ? device.device : "Remembered earlier"}
                                                            </button>
                                                            {device.current ? (
                                                                <Badge variant="primary">This device</Badge>
                                                            ) : null}
                                                        </p>
                                                        <p className="truncate text-xs text-muted-foreground lg:hidden">
                                                            {origin(device)}
                                                        </p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                                <DeviceAddress address={device} />
                                            </td>
                                            <td className="hidden max-w-[12rem] px-3 py-2 text-xs text-muted-foreground xl:table-cell">
                                                <span className="block truncate">{device.host ?? "Not recorded"}</span>
                                            </td>
                                            <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground 2xl:table-cell">
                                                {device.rememberedAt ? (
                                                    <RelativeTime iso={device.rememberedAt} />
                                                ) : (
                                                    "Not recorded"
                                                )}
                                            </td>
                                            <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground 2xl:table-cell">
                                                <RelativeTime iso={device.expiresAt} tense="future" />
                                            </td>
                                            <td className="px-3 py-2">
                                                <div className="flex justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        title="What this device can reach"
                                                        aria-label={`Open ${named ? device.device : "this device"}`}
                                                        onClick={() => setOpened(device)}
                                                    >
                                                        <PanelRightOpen className="size-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        title="Ask this device for a code again"
                                                        aria-label={`Stop remembering ${named ? device.device : "this device"}`}
                                                        disabled={busyId !== null}
                                                        onClick={() => void forget(device)}
                                                    >
                                                        <ShieldOff className="size-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </CardBody>

            <DeviceDialog
                device={opened}
                onOpenChange={(open) => {
                    if (!open) setOpened(null);
                }}
                onChanged={() => router.refresh()}
            />

            {confirmElement}
        </Card>
    );
}
