"use client";

/**
 * Passkeys on the account: registering one, naming it, and removing it.
 *
 * Registration runs entirely in the browser through the passkey client - the
 * credential is created by the device and never passes through Polaris code, so
 * there is no server action here to add one. Removal does go through a server
 * action, because deleting a row is not the browser's business.
 *
 * WebAuthn ties a credential to one domain, so a passkey registered on the
 * deployment's public address does not work when the same Polaris is opened by
 * its local name. The card says so rather than letting a failed ceremony be the
 * explanation.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Trash2 } from "lucide-react";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { authClient } from "@/lib/auth-client";
import { removePasskeyAction, type PasskeyView } from "./passkey-actions";
import { Feedback } from "./setting-card";

export function PasskeysCard({
    passkeys,
    appHost
}: {
    passkeys: PasskeyView[];
    /** The hostname passkeys are bound to, so the copy can name it. */
    appHost: string;
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removing, startRemove] = useTransition();

    const onThisHost = typeof window !== "undefined" && window.location.hostname === appHost;

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
                        Sign in with your device instead of a password. A passkey works on{" "}
                        <code className="rounded bg-muted px-1">{appHost}</code> only.
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

                {!onThisHost && (
                    <p className="text-xs text-warning">
                        You are not on {appHost} right now, so a passkey registered here would not
                        be usable. Open Polaris on that address first.
                    </p>
                )}

                <div className="flex items-start gap-2">
                    <Input
                        value={name}
                        placeholder="Name this device (optional)"
                        onChange={(event) => setName(event.target.value)}
                    />
                    <Button onClick={() => void add()} disabled={busy}>
                        {busy ? "Waiting..." : "Add a passkey"}
                    </Button>
                </div>
                <Feedback error={error} />
                {confirmElement}
            </CardBody>
        </Card>
    );
}
