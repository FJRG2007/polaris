"use client";

/**
 * Passkeys on the account: registering one, naming it, and removing it.
 *
 * Registration runs entirely in the browser through the passkey client - the
 * credential is created by the device and never passes through Polaris code, so
 * there is no server action here to add one. Removal does go through a server
 * action, because deleting a row is not the browser's business.
 *
 * WebAuthn ties a credential to one address. The server issues the challenge for
 * whichever of this deployment's names the browser is on, so a passkey can be
 * added anywhere it is reachable; the card names the address on each one and says
 * when the address in hand cannot hold a passkey at all.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Trash2 } from "lucide-react";
import { passkeyRelyingPartyId } from "@polaris/core";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { authClient } from "@/lib/auth-client";
import { removePasskeyAction, type PasskeyView } from "./passkey-actions";
import { Feedback } from "./setting-card";

/** The address this browser is on: the name a new passkey would be bound to, and
 *  whether the page is served securely enough for the browser to create one. Read
 *  after mount, since the server has no view of it. */
interface Here {
    host: string | null;
    secure: boolean;
}

export function PasskeysCard({ passkeys }: { passkeys: PasskeyView[] }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [here, setHere] = useState<Here | null>(null);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removing, startRemove] = useTransition();

    useEffect(() => {
        setHere({
            host: passkeyRelyingPartyId(window.location.hostname),
            secure: window.isSecureContext
        });
    }, []);

    const canAdd = Boolean(here?.host && here.secure);
    const noneHere = canAdd && passkeys.length > 0 && !passkeys.some((key) => key.host === here?.host);

    async function add() {
        setBusy(true);
        setError(null);
        const result = await authClient.passkey.addPasskey({ name: name.trim() || undefined });
        setBusy(false);
        if (result?.error) {
            // A cancelled prompt is a choice, not a failure worth shouting about.
            setError(result.error.message ?? "That did not complete. Try again.");
            return;
        }
        setName("");
        router.refresh();
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

                {passkeys.length > 0 && (
                    <div className="overflow-hidden rounded-md border border-border">
                        {passkeys.map((passkey) => (
                            <div
                                key={passkey.id}
                                className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 first:border-t-0"
                            >
                                <div className="flex min-w-0 items-center gap-2">
                                    <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate text-sm">{passkey.name}</span>
                                    <code className="shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground">
                                        {passkey.host}
                                    </code>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        added {new Date(passkey.addedAt).toLocaleDateString()}
                                    </span>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Remove ${passkey.name}`}
                                    title="Remove"
                                    disabled={removing}
                                    onClick={() => void remove(passkey)}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </div>
                        ))}
                    </div>
                )}

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
                    <Input
                        value={name}
                        placeholder="Name this device (optional)"
                        onChange={(event) => setName(event.target.value)}
                    />
                    <Button onClick={() => void add()} disabled={busy || !canAdd}>
                        {busy ? "Waiting..." : "Add a passkey"}
                    </Button>
                </div>
                <Feedback error={error} />
                {confirmElement}
            </CardBody>
        </Card>
    );
}
