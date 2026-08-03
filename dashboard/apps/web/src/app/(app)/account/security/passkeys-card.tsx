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
import { authClient } from "@/lib/auth-client";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import type { PasskeyView } from "@/lib/passkey-directory";
import { Feedback, type SettingLock } from "./setting-card";
import { KeyRound, Trash2, Laptop, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { PASSKEY_NAME_MAX, passkeyNameKey, passkeyRelyingPartyId } from "@polaris/core";
import { confirmPasswordForPasskeyAction, removePasskeyAction } from "./passkey-actions";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
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
function nameProblem(name: string, passkeys: PasskeyView[]): string | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (trimmed.length > PASSKEY_NAME_MAX) return `Keep it under ${PASSKEY_NAME_MAX} characters.`;
    const key = passkeyNameKey(trimmed);
    return passkeys.some((passkey) => passkeyNameKey(passkey.name) === key)
        ? "You already have a passkey with this name."
        : null;
}

export function PasskeysCard({ passkeys, lock }: { passkeys: PasskeyView[]; lock?: SettingLock }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [here, setHere] = useState<Here | null>(null);
    const [name, setName] = useState("");
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removing, startRemove] = useTransition();

    useEffect(() => {
        setHere({
            host: passkeyRelyingPartyId(window.location.hostname),
            secure: window.isSecureContext
        });
    }, []);

    const problem = useMemo(() => nameProblem(name, passkeys), [name, passkeys]);
    const supported = Boolean(here?.host && here.secure);
    const canAdd = supported && !lock && name.trim().length > 0 && !problem;
    const noneHere = supported && passkeys.length > 0 && !passkeys.some((key) => key.host === here?.host);

    /** Register the credential, once the password has been proved. The prompt is
     *  raised by the device; a cancelled one is a choice, not a failure. */
    async function register() {
        setBusy(true);
        setError(null);
        const result = await authClient.passkey.addPasskey({ name: name.trim() });
        setBusy(false);
        if (result?.error) {
            setError(result.error.message ?? "That did not complete. Try again.");
            return;
        }
        setName("");
        setAsking(false);
        router.refresh();
    }

    async function confirmPassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError(null);
        const result = await confirmPasswordForPasskeyAction(String(form.get("password") ?? ""));
        if (result.error) {
            setBusy(false);
            setError(result.error);
            return;
        }
        await register();
    }

    async function remove(passkey: PasskeyView) {
        const ok = await confirm({
            title: `Remove ${passkey.name}?`,
            description: "That device can no longer sign in with this passkey.",
            confirmLabel: "Remove",
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
                <div>
                    <h2 className="text-sm font-medium">Passkeys</h2>
                    <p className="text-xs text-muted-foreground">
                        Sign in with your device instead of a password. Each passkey works on the
                        address it was added from, so add one per address you use.
                    </p>
                </div>

                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                            {/* Each column waits for the width that actually holds it, and
                                nothing arrives at md: that is where the navigation rail
                                appears, so the content area is narrower there than it was
                                a breakpoint earlier. A column that comes early does not
                                wrap - it puts the whole table on a horizontal scrollbar. */}
                            <tr>
                                {/* w-full max-w-0: the line folded under the name is nowrap
                                    text, and uncapped it sets a floor under this column
                                    that no truncating gets below. */}
                                <th className="w-full max-w-0 px-3 py-2 font-medium">Name</th>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">Added from</th>
                                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">Address</th>
                                <th className="hidden px-3 py-2 font-medium xl:table-cell">Works on</th>
                                <th className="hidden px-3 py-2 font-medium 2xl:table-cell">Added</th>
                                <th className="hidden px-3 py-2 font-medium lg:table-cell">Last used</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {passkeys.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                                        No passkeys yet. Add one to sign in with this device.
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
                                                    <p className="truncate text-xs text-muted-foreground lg:hidden">
                                                        {passkey.browser} on {passkey.os}
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                            <span className="flex items-center gap-1.5">
                                                <Laptop className="size-3.5 shrink-0" />
                                                {passkey.browser} on {passkey.os}
                                            </span>
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground 2xl:table-cell">
                                            {passkey.ip ? (
                                                <span className="font-mono">{passkey.ip}</span>
                                            ) : (
                                                "Not recorded"
                                            )}
                                        </td>
                                        <td className="hidden max-w-[12rem] px-3 py-2 text-xs text-muted-foreground xl:table-cell">
                                            <span className="block truncate font-mono">{passkey.host}</span>
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground 2xl:table-cell">
                                            <RelativeTime iso={passkey.addedAt} />
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                            {passkey.lastUsedAt ? (
                                                <RelativeTime iso={passkey.lastUsedAt} />
                                            ) : (
                                                "Never used"
                                            )}
                                        </td>
                                        <td className="px-3 py-2">
                                            <div className="flex justify-end">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Remove ${passkey.name}`}
                                                    title="Remove"
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
                    <p className="text-xs text-warning">
                        You are on an IP address. A passkey needs a hostname, so open Polaris on a
                        domain or on its local name to add one.
                    </p>
                )}
                {here?.host && !here.secure && (
                    <p className="text-xs text-warning">
                        This address is served over plain HTTP, and browsers only create passkeys
                        over HTTPS. Open Polaris on {here.host} over HTTPS to add one.
                    </p>
                )}
                {noneHere && (
                    <p className="text-xs text-muted-foreground">
                        None of these work on {here?.host}. Add one to sign in here with your device.
                    </p>
                )}

                <div className="flex items-start gap-2">
                    {/* A name field is a few words wide whatever the page is; letting it
                        run the full width of a wide table only makes it harder to read. */}
                    <div className="flex-1 sm:max-w-sm">
                        <Input
                            value={name}
                            maxLength={PASSKEY_NAME_MAX}
                            placeholder="Name this device"
                            aria-label="Passkey name"
                            aria-invalid={problem ? true : undefined}
                            onChange={(event) => setName(event.target.value)}
                        />
                        {problem ? <p className="mt-1 text-xs text-danger">{problem}</p> : null}
                    </div>
                    <Button onClick={() => setAsking(true)} disabled={!canAdd}>
                        Add a passkey
                    </Button>
                </div>
                <Feedback error={lock?.reason ?? error} />
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
                        <DialogTitle>Confirm your password</DialogTitle>
                        <DialogDescription>
                            Adding a passkey adds a way into your account, so it asks for your
                            password first. Your device will prompt you next.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={confirmPassword} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Current password
                            <Input name="password" type="password" required autoComplete="current-password" />
                        </label>
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <ShieldCheck className="size-3.5 shrink-0" />
                            Naming it &quot;{name.trim()}&quot;.
                        </p>
                        <Feedback error={error} />
                        <div className="flex justify-end gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setAsking(false)}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? "Waiting..." : "Continue"}
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
