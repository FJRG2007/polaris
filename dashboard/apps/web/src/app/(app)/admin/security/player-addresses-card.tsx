"use client";

/**
 * Whether game server managers see where other people sign in from.
 *
 * Saved as it is flipped, since it is one answer with nothing to fill in beside
 * it; a save that fails puts the switch back where it was and says so.
 */

import { useState, useTransition } from "react";
import { Card, CardBody, Switch } from "@polaris/ui";
import { savePlayerAddressesSharedAction } from "./actions";
import { Feedback } from "@/app/(app)/account/security/setting-card";

export function PlayerAddressesCard({ shared }: { shared: boolean }) {
    const [on, setOn] = useState(shared);
    const [error, setError] = useState<string | null>(null);
    const [pending, startSaving] = useTransition();

    function change(next: boolean) {
        const previous = on;
        setOn(next);
        setError(null);
        startSaving(async () => {
            try {
                const result = await savePlayerAddressesSharedAction(next);
                if (result.error) {
                    setOn(previous);
                    setError(result.error);
                }
            } catch {
                setOn(previous);
                setError("Could not save that. Try again.");
            }
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-sm font-medium">Show player addresses to game server managers</h2>
                        <p className="text-xs text-muted-foreground">
                            When someone managing a game server looks up a Polaris account to add it as a
                            player, they see the addresses that account signs in from. Turned off, only
                            administrators see them.
                        </p>
                    </div>
                    <Switch
                        checked={on}
                        disabled={pending}
                        onChange={change}
                        aria-label="Show player addresses to game server managers"
                    />
                </div>
                <Feedback error={error ?? undefined} />
            </CardBody>
        </Card>
    );
}
