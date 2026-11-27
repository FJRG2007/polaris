"use client";

/**
 * Passkeys on the account: registering one, naming it, and removing it.
 *
 * Registration runs in the browser through the passkey client - the credential
 * is created by the device and never passes through Polaris code, so there is no
 * server action that adds one. What does go through the server is the step
 * before it: the account password, proved once so the ceremony is allowed to
 * start. Without it an open session on a borrowed screen is enough to attach a
 * permanent way in, because WebAuthn only ever proves the device.
 *
 * WebAuthn ties a credential to one address. The server issues the challenge for
 * whichever of this deployment's names the browser is on, so a passkey can be
 * added anywhere it is reachable; the table names the address on each one and
 * says when the address in hand cannot hold a passkey at all.
 *
 * A name is required, and required to be unlike the others. When somebody comes
 * to remove a credential they do not recognise, the name is the only handle they
 * have on it - three rows reading "Unnamed passkey" is a list nobody can act on.
 * The field says so as it is typed; the server refuses the same thing, because
 * the ceremony is reachable without this screen.
 */

import { useRouter } from "next/navigation";
import { passkeyProblem } from "./known-sentences";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { authClient } from "@/lib/auth-client";
import { rememberLocalPasskey } from "@/lib/local-passkeys";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import type { PasskeyView } from "@/lib/passkey-directory";
import { Feedback, type SettingLock } from "./setting-card";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { BrowserMark, SystemMark } from "@/components/client-marks";
import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { PASSKEY_NAME_MAX, passkeyNameKey, passkeyRelyingPartyId } from "@polaris/core";
import { confirmPasswordForPasskeyAction, notePasskeyAddedAction, removePasskeyAction } from "./passkey-actions";
import { passwordToSend } from "@/lib/password-proof-client";
import { SlowSubmitLabel } from "@/components/slow-submit-label";
import {
    Button,
    Card,
    CardBody,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    settingType
} from "@polaris/ui";

/** The address this browser is on: the name a new passkey would be bound to, and
 *  whether the page is served securely enough for the browser to create one. Read
 *  after mount, since the server has no view of it. */
interface Here {
    host: string | null;
    secure: boolean;
}

/** Why this name cannot be used, or null when it can. Runs on every keystroke
 *  against the passkeys already on screen, so the problem is named before the
 *  device raises a prompt that would only fail. */
function nameProblem(t: NamespaceTranslator<"accountSecurity">, name: string, passkeys: PasskeyView[]): string | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (trimmed.length > PASSKEY_NAME_MAX) return t("passkeys.nameTooLong", { max: PASSKEY_NAME_MAX });
    const key = passkeyNameKey(trimmed);
    return passkeys.some((passkey) => passkeyNameKey(passkey.name) === key) ? t("passkeys.nameTaken") : null;
}

export function PasskeysCard({ passkeys, lock }: { passkeys: PasskeyView[]; lock?: SettingLock }) {
    const router = useRouter();
    const t = useTranslations("accountSecurity");
    const tv = useTranslations("validation");
    const tc = useTranslations("common");
    const [confirm, confirmElement] = useConfirm();
    const [here, setHere] = useState<Here | null>(null);
    const [name, setName] = useState("");
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [protecting, setProtecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removing, startRemove] = useTransition();

    useEffect(() => {
        setHere({
            host: passkeyRelyingPartyId(window.location.hostname),
            secure: window.isSecureContext
        });
    }, []);

    const problem = useMemo(() => nameProblem(t, name, passkeys), [t, name, passkeys]);
    const supported = Boolean(here?.host && here.secure);
    const canAdd = supported && !lock && name.trim().length > 0 && !problem;
    const noneHere = supported && passkeys.length > 0 && !passkeys.some((key) => key.host === here?.host);

    /** Register the credential, once the password has been proved. The prompt is
     *  raised by the device; a cancelled one is a choice, not a failure. */
    async function register() {
        setBusy(true);
        setError(null);
        const result = await authClient.passkey.addPasskey({
            name: name.trim(),
            returnWebAuthnResponse: true
        });
        setBusy(false);
        if (result?.error) {
            setError(passkeyProblem(t, tv, result.error, t("passkeys.notCompleted")));
            return;
        }
        // Made on this device (Windows Hello, Touch ID...): the next sign-in here
        // can ask for it on its own. A phone or a USB key is not noted.
        const created = (result as { webauthn?: { response?: { id: string; authenticatorAttachment?: string } } })
            .webauthn?.response;
        if (created) rememberLocalPasskey(created);
        setName("");
        setAsking(false);
        // The credential was written by the passkey client, so the server is told
        // to log it and alert the account. It has nothing to add to the screen,
        // and a failure here must not read as a registration that did not happen.
        await notePasskeyAddedAction().catch(() => undefined);
        router.refresh();
    }

    async function confirmPassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!canAdd) return;
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setProtecting(false);
        setError(null);
        const password = String(form.get("password") ?? "");
        const result = await confirmPasswordForPasskeyAction(await passwordToSend(password, () => setProtecting(true)));
        if (result.error) {
            setBusy(false);
            setError(result.error);
            return;
        }
        await register();
    }

    async function remove(passkey: PasskeyView) {
        const ok = await confirm({
            title: t("passkeys.removeTitle", { name: passkey.name }),
            description: t("passkeys.removeDescription"),
            confirmLabel: t("passkeys.remove"),
            danger: true
        });
        if (!ok) return;
        startRemove(async () => {
            const result = await removePasskeyAction(passkey.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                {/* Adding sits in the header and opens a dialog, as on every list in Polaris. */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 basis-64">
                        <h2 className="text-sm font-medium">{t("passkeys.title")}</h2>
                        <p className={settingType.hint}>{t("passkeys.description")}</p>
                    </div>
                    <Button
                        size="sm"
                        disabled={!supported || Boolean(lock)}
                        title={lock?.reason}
                        onClick={() => {
                            setName("");
                            setError(null);
                            setAsking(true);
                        }}
                    >
                        <Plus className="size-4" />
                        {t("passkeys.add")}
                    </Button>
                </div>

                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className={cn(settingType.body, "w-full")}>
                        <thead className={cn(settingType.small, "bg-surface/60 text-start text-muted-foreground")}>
                            {/* Each column waits for the width that actually holds it, and
                                nothing arrives at md: that is where the navigation rail
                                appears, so the content area is narrower there than it was
                                a breakpoint earlier. A column that comes early does not
                                wrap - it puts the whole table on a horizontal scrollbar. */}
                            <tr>
                                {/* w-full max-w-0: the line folded under the name is nowrap
                                    text, and uncapped it sets a floor under this column
                                    that no truncating gets below. */}
                                <th className="w-full max-w-0 px-3 py-2 font-medium">{t("passkeys.columns.name")}</th>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("passkeys.columns.addedFrom")}</th>
                                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">{t("passkeys.columns.address")}</th>
                                <th className="hidden px-3 py-2 font-medium xl:table-cell">{t("passkeys.columns.worksOn")}</th>
                                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">{t("passkeys.columns.added")}</th>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("passkeys.columns.lastUsed")}</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {passkeys.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                                        {t("passkeys.empty")}
                                    </td>
                                </tr>
                            ) : (
                                passkeys.map((passkey) => (
                                    <tr key={passkey.id} className="border-t border-border">
                                        <td className="w-full max-w-0 px-3 py-2">
                                            <div className="flex items-center gap-3">
                                                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                                                <div className="min-w-0">
                                                    <p className="truncate">{passkey.name}</p>
                                                    <p className={cn(settingType.hint, "truncate lg:hidden")}>
                                                        {t("passkeys.browserOn", { browser: passkey.browser, os: passkey.os })}
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className={cn(settingType.hint, "hidden whitespace-nowrap px-3 py-2 lg:table-cell")}>
                                            <PasskeyOrigin passkey={passkey} />
                                        </td>
                                        <td className={cn(settingType.hint, "hidden whitespace-nowrap px-3 py-2 2xl:table-cell")}>
                                            {passkey.ip ? (
                                                <span className="font-mono">{passkey.ip}</span>
                                            ) : (
                                                t("passkeys.notRecorded")
                                            )}
                                        </td>
                                        <td className={cn(settingType.hint, "hidden max-w-[12rem] px-3 py-2 xl:table-cell")}>
                                            <span className="block truncate font-mono">{passkey.host}</span>
                                        </td>
                                        <td className={cn(settingType.hint, "hidden whitespace-nowrap px-3 py-2 2xl:table-cell")}>
                                            <RelativeTime iso={passkey.addedAt} />
                                        </td>
                                        <td className={cn(settingType.hint, "hidden whitespace-nowrap px-3 py-2 lg:table-cell")}>
                                            {passkey.lastUsedAt ? (
                                                <RelativeTime iso={passkey.lastUsedAt} />
                                            ) : (
                                                t("passkeys.neverUsed")
                                            )}
                                        </td>
                                        <td className="px-3 py-2">
                                            <div className="flex justify-end">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("passkeys.removeNamed", { name: passkey.name })}
                                                    title={t("passkeys.remove")}
                                                    disabled={removing || Boolean(lock)}
                                                    onClick={() => void remove(passkey)}
                                                >
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {here && !here.host && (
                    <p className={cn(settingType.small, "text-warning")}>{t("passkeys.onIpAddress")}</p>
                )}
                {here?.host && !here.secure && (
                    <p className={cn(settingType.small, "text-warning")}>{t("passkeys.plainHttp", { host: here.host })}</p>
                )}
                {noneHere && (
                    <p className={settingType.hint}>{t("passkeys.noneHere", { host: here?.host ?? "" })}</p>
                )}

                <Feedback error={lock?.reason ?? (asking ? null : error)} />
                {confirmElement}
            </CardBody>

            <Dialog
                open={asking}
                onOpenChange={(open) => {
                    if (busy) return;
                    setAsking(open);
                    if (!open) setError(null);
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("passkeys.confirmTitle")}</DialogTitle>
                        <DialogDescription>{t("passkeys.confirmDescription")}</DialogDescription>
                    </DialogHeader>
                    <form onSubmit={confirmPassword} className="flex flex-col gap-3">
                        {/* The name is checked as it is typed against the passkeys on screen, so the
                            problem is named before the device raises a prompt that would only fail. */}
                        <label className={cn(settingType.body, "flex flex-col gap-1")}>
                            {t("passkeys.nameLabel")} *
                            <Input
                                value={name}
                                maxLength={PASSKEY_NAME_MAX}
                                placeholder={t("passkeys.namePlaceholder")}
                                aria-invalid={problem ? true : undefined}
                                autoFocus
                                autoComplete="off"
                                onChange={(event) => setName(event.target.value)}
                            />
                            {problem ? <span className={settingType.error}>{problem}</span> : null}
                        </label>
                        <label className={cn(settingType.body, "flex flex-col gap-1")}>
                            {t("dialog.currentPassword")}
                            <Input name="password" type="password" required autoComplete="current-password" />
                        </label>
                        <Feedback error={error} />
                        <div className="flex justify-end gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setAsking(false)}
                            >
                                {tc("actions.cancel")}
                            </Button>
                            <Button type="submit" disabled={busy} aria-disabled={!canAdd || undefined}>
                                {busy ? (
                                    <SlowSubmitLabel busyLabel={t("dialog.waiting")} protecting={protecting} />
                                ) : (
                                    t("dialog.continue")
                                )}
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}

/**
 * Where a passkey came from, with the browser and system marks the sessions table
 * draws. A row whose origin was filled in on a later sign-in says so, rather than
 * passing that sign-in off as where the passkey was added.
 */
function PasskeyOrigin({ passkey }: { passkey: PasskeyView }) {
    const t = useTranslations("accountSecurity");
    if (passkey.browser === "Unknown browser" && passkey.os === "Unknown OS") {
        return <span>{t("passkeys.originUnknown")}</span>;
    }
    return (
        <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                    <BrowserMark browser={passkey.browser} />
                    <span className="truncate" title={passkey.browser}>{passkey.browser}</span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                    <SystemMark os={passkey.os} />
                    <span className="truncate" title={passkey.os}>{passkey.os}</span>
                </span>
            </span>
            {passkey.originSeenAt ? (
                <span className={settingType.hint} title={t("passkeys.firstSeenHint")}>
                    {t("passkeys.firstSeen")} <RelativeTime iso={passkey.originSeenAt} />
                </span>
            ) : null}
        </span>
    );
}
