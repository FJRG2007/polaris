"use client";

/**
 * Connecting the account a place's locks are on.
 *
 * One field that matters, and a paragraph explaining where to get what goes in
 * it, because that part genuinely is not Polaris' to do: the token is made in the
 * lock maker's own web console, and no amount of screen here can produce one.
 * Everything after it is - the doors arrive, get their names, and answer.
 *
 * The token is written once and never shown again. There is no "reveal" and no
 * masked copy of it in a field on the next visit: it is a key to somebody's front
 * door, and a screen that can print it back is a screen somebody can be walked
 * into opening.
 */

import Link from "next/link";
import { useState } from "react";
import * as actions from "../actions";
import { runAction } from "@/lib/run-action";
import { ExternalLink, Loader2 } from "lucide-react";
import { deviceAccountSchema } from "@/lib/home/schemas";
import type { DeviceView } from "@/lib/home/device-kinds";
import type { NukiConnection } from "@/lib/home/nuki-devices";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** Where the token is made. Named exactly, and linked, because "create an API
 *  token" is three screens deep and everybody looks for it in the phone app. */
const TOKEN_PAGE = "https://web.nuki.io/#/admin/web-api";

export function ConnectDialog({
    open,
    connected,
    onClose,
    onConnected
}: {
    open: boolean;
    /** Reconnecting rather than connecting, which is what a refused token needs
     *  and is worth saying out loud - the old one is replaced, not added to. */
    connected: boolean;
    onClose: () => void;
    onConnected: (result: { devices: DeviceView[]; account: NukiConnection }) => void;
}) {
    const [label, setLabel] = useState("");
    const [token, setToken] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const issue = token.trim()
        ? (deviceAccountSchema.shape.token.safeParse(token).error?.issues[0]?.message ?? null)
        : null;
    const canSubmit = token.trim().length > 0 && !issue && !saving;

    const submit = async () => {
        if (!canSubmit) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => actions.connectDeviceAccountAction({ label, token }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setToken("");
        setLabel("");
        onConnected({ devices: result.devices ?? [], account: result.account as NukiConnection });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{connected ? "Reconnect Nuki" : "Connect Nuki"}</DialogTitle>
                    <DialogDescription>
                        Polaris reaches the locks through your Nuki account, so they answer from
                        anywhere rather than only on their own network.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs text-muted-foreground">
                        <li>
                            Open{" "}
                            <Link
                                href={TOKEN_PAGE}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-foreground underline"
                            >
                                Nuki Web <ExternalLink className="size-3" />
                            </Link>{" "}
                            and sign in with the account the locks are on.
                        </li>
                        <li>Under API, create a token that may see and operate your Smart Locks.</li>
                        <li>Paste it here. Nuki shows it once.</li>
                    </ol>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">API token</span>
                        <Input
                            autoFocus
                            type="password"
                            value={token}
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="Paste the token"
                            onChange={(event) => setToken(event.target.value)}
                            aria-label="API token"
                        />
                        {issue && <span className="text-xs text-danger">{issue}</span>}
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                            Name for this account <span className="text-foreground-subtle">optional</span>
                        </span>
                        <Input
                            value={label}
                            maxLength={60}
                            placeholder="Nuki"
                            onChange={(event) => setLabel(event.target.value)}
                            aria-label="Name for this account"
                        />
                    </label>

                    {error && (
                        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={() => void submit()} disabled={!canSubmit}>
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        {saving ? "Checking" : "Connect"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
