"use client";

/**
 * Who may connect to a game server, and from where.
 *
 * Lives here rather than on either screen because it belongs to both: it is the
 * server's moderation list on the Players tab, and it is that server's firewall on
 * the Firewall page - the same rules, reached from whichever of the two an
 * operator happened to open. A second copy would have drifted within a month.
 *
 * A username on its own is a password anybody who learns it can use. The address is
 * what makes the name mean one line, and the switch turns that half off - worded
 * as what it costs rather than as a preference.
 */

import { UserMinus, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { GameAccessForm } from "@/components/game-access-form";
import { ACCESS_REACH_NOTE } from "@/lib/apps/minecraft/access";
import { Badge, Button, Card, CardBody, Switch } from "@polaris/ui";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import {
    grantPlayerAccessAction,
    revokePlayerAccessAction,
    revokePlayerAddressAction,
    setAddressBindingAction
} from "@/app/(app)/apps/installed/[id]/minecraft-actions";

export function GameAccessEditor({
    installedAppId,
    access,
    onChanged,
    onError
}: {
    installedAppId: string;
    /** Null while it is still being read. */
    access: PlayerAccessView | null;
    onChanged: () => void;
    onError?: (message: string | null) => void;
}) {
    const [pending, startTransition] = useTransition();
    const [failure, setFailure] = useState<string | null>(null);

    const edition = access?.edition ?? "java";
    const rules = access?.rules ?? [];
    // One row per address in the table, one line per person on the screen. A
    // player who plays from home and from a laptop is one entry with two badges,
    // not two entries that read like two people.
    const people = useMemo(() => {
        const byName = new Map<string, { username: string; note: string | null; addresses: string[] }>();
        for (const rule of rules) {
            const key = rule.username.toLowerCase();
            const held = byName.get(key);
            if (held) {
                if (!held.addresses.includes(rule.address)) held.addresses.push(rule.address);
                if (!held.note && rule.note) held.note = rule.note;
                continue;
            }
            byName.set(key, { username: rule.username, note: rule.note, addresses: [rule.address] });
        }
        return [...byName.values()];
    }, [rules]);

    /** Report upward when the host screen collects errors, and locally otherwise -
     *  a failure that only one of the two screens can show is a failure the other
     *  swallows. */
    function report(message: string | null): void {
        setFailure(message);
        onError?.(message);
    }

    function run(action: () => Promise<{ error?: string }>): void {
        report(null);
        startTransition(async () => {
            const result = await action();
            if (result.error) {
                report(result.error);
                return;
            }
            onChanged();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                        Who can connect <span className="text-muted-foreground">{rules.length || ""}</span>
                    </p>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            {access?.bindAddresses ? "Address checked" : "Address not checked"}
                        </span>
                        <Switch
                            checked={access?.bindAddresses ?? true}
                            onChange={(enabled) => run(() => setAddressBindingAction(installedAppId, enabled))}
                            disabled={pending || access === null || !access.addressesAvailable}
                            aria-label="Check each player's address when they join"
                        />
                    </div>
                </div>

                <p className="text-xs text-muted-foreground">
                    A player is let in when the username is on this list and they arrive from the address registered to
                    it. The rest of the firewall guards HTTP, which a game port is not.
                </p>
                <p className="text-xs text-muted-foreground">{ACCESS_REACH_NOTE}</p>

                <GameAccessForm
                    edition={edition}
                    disabled={pending}
                    onAdd={async (input) => {
                        report(null);
                        const result = await grantPlayerAccessAction({ installedAppId, ...input });
                        if (result.error) {
                            report(result.error);
                            return false;
                        }
                        onChanged();
                        return true;
                    }}
                />

                {access === null ? (
                    <p className="py-3 text-sm text-muted-foreground">Reading the list...</p>
                ) : rules.length === 0 ? (
                    <p className="py-3 text-sm text-muted-foreground">
                        Nobody is registered yet, so nobody can join.
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border/60">
                        {people.map((person) => (
                            <li key={person.username} className="flex items-start gap-2 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm" title={person.username}>
                                        {person.username}
                                    </p>
                                    {person.note && (
                                        <p className="truncate text-xs text-muted-foreground" title={person.note}>
                                            {person.note}
                                        </p>
                                    )}
                                </div>
                                <div className="flex max-w-[60%] flex-wrap justify-end gap-1">
                                    {person.addresses.map((address) => (
                                        <span key={address} className="inline-flex items-center gap-0.5">
                                            <Badge>{address}</Badge>
                                            {/* Each address goes on its own. Taking the last
                                                one takes the player, which the service decides
                                                so both screens agree about it. */}
                                            <button
                                                type="button"
                                                disabled={pending}
                                                aria-label={`Remove ${address} from ${person.username}`}
                                                title={`Remove ${address} from ${person.username}`}
                                                className="text-muted-foreground hover:text-danger disabled:opacity-50"
                                                onClick={() =>
                                                    run(() =>
                                                        revokePlayerAddressAction(
                                                            installedAppId,
                                                            person.username,
                                                            address
                                                        )
                                                    )
                                                }
                                            >
                                                <X className="size-3" />
                                            </button>
                                        </span>
                                    ))}
                                </div>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={pending}
                                    aria-label={`Remove ${person.username}`}
                                    title={`Remove ${person.username} and every address they have`}
                                    onClick={() =>
                                        run(() => revokePlayerAccessAction(installedAppId, person.username))
                                    }
                                >
                                    <UserMinus className="size-4" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}

                {access && !access.addressesAvailable && (
                    <p className="text-xs text-muted-foreground">
                        Bedrock does not record where a player connected from, so only the names here are enforced.
                    </p>
                )}
                {failure && !onError && <p className="text-xs text-danger">{failure}</p>}
            </CardBody>
        </Card>
    );
}
