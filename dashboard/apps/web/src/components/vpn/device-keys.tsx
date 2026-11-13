"use client";

/**
 * The one-time keys that add a device with no browser - a router, a server, a
 * TV - to the VPN. One creator, used by the VPN's Add a device page and by the
 * new-key page in Account > API keys, and one list, on the API keys page, where
 * a key is seen and revoked.
 *
 * The control server is the record: what is listed is what it reports for the
 * account, so a key made anywhere shows up here, and revoking one expires it
 * there.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import { KeyRound, Loader2 } from "lucide-react";
import * as actions from "@/app/(app)/vpn/actions";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { connectCommand, type DeviceKey, type DeviceKeyState } from "@/lib/vpn/device-keys";
import { useCallback, useEffect, useState, useTransition } from "react";

/** Where the keys are listed. */
export const DEVICE_KEYS_HREF = "/account/api-keys#vpn-keys";


interface Made {
    readonly key: string;
    readonly expiresAt: string;
    readonly loginServer: string | null;
}

/** Make a key, then show it with its command when the device needs one. */
export function VpnKeyCreator({
    withCommand,
    disabledReason = null
}: {
    /** Show the command a router or server runs, filled in with the key. */
    withCommand: boolean;
    /** Why a key cannot be made right now; the button is off and says so. */
    disabledReason?: string | null;
}) {
    const t = useTranslations("vpn");
    const [made, setMade] = useState<Made | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function create(): void {
        setError(null);
        startTransition(async () => {
            const result = await actions
                .createVpnKeyAction()
                .catch(() => ({ error: t("errors.generic") }));
            if (result.error !== undefined) setError(result.error);
            else setMade(result);
        });
    }

    const command =
        withCommand && made?.loginServer ? connectCommand(made.loginServer, made.key) : null;

    return (
        <div className="flex w-full min-w-0 flex-col items-start gap-3">
            {made ? (
                <div className="flex w-full min-w-0 flex-col gap-1">
                    <CopyLine value={made.key} label={t("keys.copyKey")} />
                    <p className="text-xs text-muted-foreground">
                        {t("keys.expiresAt", {
                            time: new Date(made.expiresAt).toLocaleTimeString()
                        })}
                    </p>
                </div>
            ) : null}
            {command ? (
                <div className="flex w-full min-w-0 flex-col gap-1">
                    <p className="text-sm">{t("keys.commandHint")}</p>
                    <CopyLine value={command} label={t("keys.copyCommand")} />
                </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
                <ui.Button
                    size="sm"
                    variant="outline"
                    disabled={pending || disabledReason !== null}
                    title={disabledReason ?? undefined}
                    onClick={create}
                >
                    {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
                    {made ? t("keys.another") : t("keys.create")}
                </ui.Button>
                <Link className="text-sm text-primary underline" href={DEVICE_KEYS_HREF}>
                    {t("keys.manage")}
                </Link>
            </div>
            {disabledReason ? (
                <p className="text-sm text-muted-foreground">{disabledReason}</p>
            ) : null}
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

function CopyLine({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex w-full min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
                {value}
            </code>
            <ui.CopyButton value={value} label={label} />
        </div>
    );
}

const STATE_VARIANT: Record<DeviceKeyState, "success" | "neutral" | "warning"> = {
    unused: "success",
    used: "neutral",
    expired: "warning"
};

function when(value: string | null): string {
    return value ? new Date(value).toLocaleString() : "-";
}

/**
 * The account's device keys, for Account > API keys. Renders nothing when the
 * VPN is off or the account may not join it: there is nothing to manage then.
 */
export function VpnDeviceKeys() {
    const t = useTranslations("vpn");
    const [keys, setKeys] = useState<DeviceKey[] | null | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [confirm, dialog] = useConfirm();

    const load = useCallback(async () => {
        const result = await actions
            .listVpnKeysAction()
            .catch(() => ({ error: t("errors.generic") }));
        if (result.error !== undefined) setError(result.error);
        else {
            setError(null);
            setKeys(result.keys);
        }
    }, [t]);

    useEffect(() => {
        void load();
    }, [load]);

    async function revoke(key: DeviceKey): Promise<void> {
        const sure = await confirm({
            title: t("keys.revokeTitle"),
            description: t("keys.revokeBody"),
            confirmLabel: t("keys.revoke"),
            danger: true
        });
        if (!sure) return;
        setBusy(key.id);
        const result = await actions
            .revokeVpnKeyAction({ keyId: key.id })
            .catch(() => ({ error: t("errors.generic") }));
        if (result.error !== undefined) setError(result.error);
        else await load();
        setBusy(null);
    }

    if (keys === null) return null;

    return (
        <section id="vpn-keys" className="flex flex-col gap-2">
            {dialog}
            <div>
                <h2 className="text-sm font-semibold">{t("keys.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("keys.intro")}</p>
            </div>
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            {keys === undefined ? (
                error ? null : (
                    <div className="flex flex-col gap-2" aria-busy="true">
                        <ui.Skeleton className="h-10 w-full" />
                        <ui.Skeleton className="h-10 w-full" />
                    </div>
                )
            ) : keys.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("keys.empty")}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {keys.map((key) => (
                        <li
                            key={key.id}
                            className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
                        >
                            <code
                                className="min-w-0 truncate font-mono text-xs"
                                title={key.hint}
                            >
                                {key.hint}
                            </code>
                            <ui.Badge variant={STATE_VARIANT[key.state]}>
                                {t(`keys.state.${key.state}`)}
                            </ui.Badge>
                            <span className="text-xs text-muted-foreground">
                                {t("keys.created", { date: when(key.createdAt) })}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {t("keys.expires", { date: when(key.expiresAt) })}
                            </span>
                            {key.state === "unused" ? (
                                <ui.Button
                                    size="sm"
                                    variant="outline"
                                    className="ml-auto"
                                    disabled={busy !== null}
                                    onClick={() => void revoke(key)}
                                >
                                    {busy === key.id ? <Loader2 className="animate-spin" /> : null}
                                    {t("keys.revoke")}
                                </ui.Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
