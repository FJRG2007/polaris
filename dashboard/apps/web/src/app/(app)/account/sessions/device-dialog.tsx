"use client";

/**
 * One remembered device, opened.
 *
 * The list can say a device is remembered and offer to stop remembering it, and
 * that is the wrong place to stop: the thing somebody does after recognising a
 * device they no longer have is find out what it can still reach. That answer is
 * spread across the session table (once per name the deployment answers on) and
 * the passkey card on another page, and none of those rows say which device they
 * belong to. This panel is the join - what the device is, where it was seen from,
 * everything it has open, and every credential it registered - and the two ways
 * to take it away, which are not the same decision: signing it out ends what it
 * has now, forgetting it means the next sign-in answers the challenge again.
 *
 * The sessions it lists are matched on what the browser reports itself to be, so
 * two machines that report themselves identically are shown as one. The panel
 * says so rather than letting the grouping read as a fact.
 */

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { KeyRound, LogOut, ShieldOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { DeviceAddress } from "@/components/device-address";
import { SessionsTable } from "@/components/sessions-table";
import { useDisplayFormat } from "@/components/display-format";
import type { SessionView, TrustedDeviceDetail, TrustedDeviceRow } from "@/lib/session-directory";
import {
    forgetTrustedDeviceAction,
    revokeSessionAction,
    signOutTrustedDeviceAction,
    trustedDeviceAction
} from "./actions";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

/** One fact about the device, as a row of the summary. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-3 border-t border-border py-1.5 first:border-t-0">
            <span className="shrink-0 text-muted-foreground">{label}</span>
            <span className="min-w-0 text-right">{children}</span>
        </div>
    );
}

export function DeviceDialog({
    device,
    onOpenChange,
    onChanged
}: {
    device: TrustedDeviceRow | null;
    onOpenChange: (open: boolean) => void;
    /** Something was ended, so the page behind this has to be re-read. */
    onChanged: () => void;
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [detail, setDetail] = useState<TrustedDeviceDetail | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const deviceId = device?.id ?? null;

    useEffect(() => {
        if (!deviceId) return;
        let active = true;
        setDetail(null);
        setError(null);
        void trustedDeviceAction(deviceId).then((result) => {
            if (!active) return;
            if (!result.detail) {
                setError(result.error ?? "Could not open this device.");
                return;
            }
            setDetail(result.detail);
        });
        return () => {
            active = false;
        };
    }, [deviceId]);

    /** Ending the session this page is being read from means dropping the cookie
     *  too, not only the row behind it. */
    async function leaveHere() {
        await signOut();
        router.push("/oauth/login");
        router.refresh();
    }

    async function signOutSession(session: SessionView) {
        if (session.current) {
            await leaveHere();
            return;
        }
        setBusy(true);
        const result = await revokeSessionAction(session.id);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setDetail((current) =>
            current ? { ...current, sessions: current.sessions.filter((row) => row.id !== session.id) } : current
        );
        onChanged();
    }

    async function signOutEverywhere() {
        if (!detail) return;
        const here = detail.sessions.some((session) => session.current);
        const ok = await confirm({
            title: "Sign this device out?",
            description: here
                ? `${detail.sessions.length} session${detail.sessions.length === 1 ? "" : "s"} end, including the one you are reading this on.`
                : `${detail.sessions.length} session${detail.sessions.length === 1 ? "" : "s"} end, on every address it signed in on.`,
            confirmLabel: "Sign it out",
            danger: true
        });
        if (!ok) return;
        setBusy(true);
        const result = await signOutTrustedDeviceAction(detail.device.id);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.endedCurrent) {
            await leaveHere();
            return;
        }
        setDetail({ ...detail, sessions: [] });
        onChanged();
    }

    async function forget() {
        if (!detail) return;
        const ok = await confirm({
            title: "Ask this device for a code again?",
            description: `${detail.device.device} answers the challenge the next time it signs in. Anything it has open stays open.`,
            confirmLabel: "Forget it",
            danger: true
        });
        if (!ok) return;
        setBusy(true);
        const result = await forgetTrustedDeviceAction(detail.device.id);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        onChanged();
    }

    return (
        <>
            <Dialog open={device !== null} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle className="flex flex-wrap items-center gap-2">
                            {device?.device ?? "Device"}
                            {device?.current ? <Badge variant="primary">This device</Badge> : null}
                        </DialogTitle>
                        <DialogDescription>
                            Signs in with the password alone until{" "}
                            {device ? format.date(device.expiresAt) : "its pass runs out"}.
                        </DialogDescription>
                    </DialogHeader>

                    {error ? <p className="mb-3 text-sm text-danger">{error}</p> : null}

                    {device ? (
                        <div className="flex flex-col gap-4">
                            <div className="rounded-lg border border-border px-3 py-1 text-sm">
                                <Fact label="Address">
                                    <DeviceAddress address={device} />
                                </Fact>
                                <Fact label="Domain">{device.host ?? "Not recorded"}</Fact>
                                <Fact label="Remembered">
                                    {device.rememberedAt ? (
                                        <RelativeTime iso={device.rememberedAt} />
                                    ) : (
                                        "Not recorded"
                                    )}
                                </Fact>
                                <Fact label="Last used">
                                    {device.lastSeenAt ? <RelativeTime iso={device.lastSeenAt} /> : "Not recorded"}
                                </Fact>
                                <Fact label="Until">
                                    <RelativeTime iso={device.expiresAt} tense="future" />
                                </Fact>
                            </div>

                            {detail === null && !error ? (
                                <div className="flex flex-col gap-2">
                                    <Skeleton className="h-9 w-full" />
                                    <Skeleton className="h-9 w-full" />
                                </div>
                            ) : null}

                            {detail && !detail.identified ? (
                                <p className="text-sm text-muted-foreground">
                                    Nothing was recorded about this device when it was remembered, so its
                                    sessions and passkeys cannot be told from another device&apos;s. Signing in
                                    on it once describes it.
                                </p>
                            ) : null}

                            {detail?.identified ? (
                                <>
                                    <section className="flex flex-col gap-2">
                                        <div>
                                            <h3 className="text-sm font-medium">Signed in</h3>
                                            <p className="text-xs text-muted-foreground">
                                                Every address this device is signed in on. Devices that report
                                                themselves the same way are counted as one.
                                            </p>
                                        </div>
                                        <SessionsTable
                                            compact
                                            sessions={detail.sessions}
                                            busyId={busy ? "all" : null}
                                            emptyLabel="Not signed in anywhere right now."
                                            onRevoke={(session) => void signOutSession(session)}
                                        />
                                    </section>

                                    <section className="flex flex-col gap-2">
                                        <div>
                                            <h3 className="text-sm font-medium">Passkeys</h3>
                                            <p className="text-xs text-muted-foreground">
                                                Credentials this device registered. Remove one from Security.
                                            </p>
                                        </div>
                                        {detail.passkeys.length === 0 ? (
                                            <p className="rounded-lg border border-border px-3 py-4 text-center text-sm text-muted-foreground">
                                                None registered from this device.
                                            </p>
                                        ) : (
                                            <ul className="overflow-hidden rounded-lg border border-border">
                                                {detail.passkeys.map((passkey) => (
                                                    <li
                                                        key={passkey.id}
                                                        className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 first:border-t-0"
                                                    >
                                                        <div className="flex min-w-0 items-center gap-2">
                                                            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                                                            <span className="truncate text-sm">{passkey.name}</span>
                                                            <code className="shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground">
                                                                {passkey.host}
                                                            </code>
                                                        </div>
                                                        <span className="shrink-0 text-xs text-muted-foreground">
                                                            added {format.date(passkey.addedAt)}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </section>
                                </>
                            ) : null}

                            <div className="flex flex-wrap justify-end gap-2">
                                {detail && detail.sessions.length > 0 ? (
                                    <Button
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void signOutEverywhere()}
                                    >
                                        <LogOut className="size-4" />
                                        Sign it out everywhere
                                    </Button>
                                ) : null}
                                <Button variant="danger" disabled={busy} onClick={() => void forget()}>
                                    <ShieldOff className="size-4" />
                                    Forget this device
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </DialogContent>
            </Dialog>
            {confirmElement}
        </>
    );
}
