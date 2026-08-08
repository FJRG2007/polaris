"use client";

/**
 * The pair a game server is opened by: a username, and the address that username
 * may arrive from.
 *
 * One component because it is one decision, and it is asked in two places - the
 * server's Players tab and its panel on the Firewall page. The address carries a
 * detect button: whoever is registering themselves is almost always sitting on
 * the line they will play from, and the alternative is sending somebody off to
 * look their own IP up. What it fills in stays editable, because the operator
 * adding a friend is not on the friend's line.
 */

import { Button, Input } from "@polaris/ui";
import { useState, useTransition } from "react";
import { Locate, Loader2, UserPlus } from "lucide-react";
import type { MinecraftEdition } from "@/lib/apps/minecraft/service";
import { isAddressRule, isPlayerName } from "@/lib/apps/minecraft/access";
import { myAddressAction } from "@/app/(app)/apps/installed/[id]/minecraft-actions";

export function GameAccessForm({
    edition,
    disabled,
    onAdd
}: {
    edition: MinecraftEdition;
    disabled?: boolean;
    /** Resolves once the grant has been attempted; the fields clear on success. */
    onAdd: (input: { username: string; address: string }) => Promise<boolean>;
}) {
    const [username, setUsername] = useState("");
    const [address, setAddress] = useState("");
    const [detecting, startDetecting] = useTransition();
    const [adding, startAdding] = useTransition();
    const [detectFailed, setDetectFailed] = useState(false);

    const nameInvalid = username.trim().length > 0 && !isPlayerName(edition, username);
    const addressInvalid = address.trim().length > 0 && !isAddressRule(address);
    const ready = isPlayerName(edition, username) && isAddressRule(address);
    const pending = detecting || adding;

    function detect(): void {
        setDetectFailed(false);
        startDetecting(async () => {
            const result = await myAddressAction();
            if (!result.address) {
                setDetectFailed(true);
                return;
            }
            setAddress(result.address);
        });
    }

    function submit(): void {
        if (!ready || pending) return;
        startAdding(async () => {
            if (!(await onAdd({ username: username.trim(), address: address.trim() }))) return;
            setUsername("");
            setAddress("");
        });
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-start gap-2">
                <Input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && submit()}
                    placeholder={edition === "bedrock" ? "Gamertag" : "Username"}
                    className="min-w-36 flex-1"
                    aria-label="Player"
                    disabled={disabled}
                />
                <div className="flex min-w-48 flex-1 items-center gap-1">
                    <Input
                        value={address}
                        onChange={(event) => setAddress(event.target.value)}
                        onKeyDown={(event) => event.key === "Enter" && submit()}
                        placeholder="203.0.113.9, 203.0.113.0/24 or any"
                        className="flex-1"
                        aria-label="Address they connect from"
                        disabled={disabled}
                    />
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={detect}
                        disabled={disabled || pending}
                        aria-label="Use the address you are on now"
                        title="Use the address you are on now"
                    >
                        {detecting ? <Loader2 className="size-4 animate-spin" /> : <Locate className="size-4" />}
                    </Button>
                </div>
                <Button size="sm" onClick={submit} disabled={disabled || pending || !ready}>
                    {adding ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />} Add
                </Button>
            </div>
            {(nameInvalid || addressInvalid) && (
                <p className="text-xs text-danger">
                    {nameInvalid ? "That is not a username this edition accepts" : "That is not an address or a range"}
                </p>
            )}
            {detectFailed && (
                <p className="text-xs text-muted-foreground">
                    Polaris could not read the address this request came from. Type it in instead.
                </p>
            )}
        </div>
    );
}
