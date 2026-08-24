"use client";

/**
 * How often somebody may change the name everyone else finds them by.
 *
 * It sits on this page rather than under Security because it decides nothing
 * about who gets in. A handle is an address: it is on a profile, it is what a
 * game server's allow-list was keyed to, and it is what another person types to
 * start a conversation. An account free to change it whenever it likes can walk
 * away from all of that repeatedly, and a handle it has just dropped is
 * available to whoever asks next - which is how one account comes to look like
 * another that has just renamed.
 *
 * Zero is offered deliberately. A deployment where everybody already knows each
 * other has no such problem to solve, and a wait it did not want would be a rule
 * with nothing behind it.
 */

import { useState, useTransition } from "react";
import { setUsernameCooldownAction } from "./actions";
import { USERNAME_COOLDOWN_MAX_DAYS } from "@polaris/core";
import { Button, Card, CardBody, Input } from "@polaris/ui";

export function UsernameCooldownForm({ days }: { days: number }) {
    const [value, setValue] = useState(String(days));
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [pending, startTransition] = useTransition();

    const parsed = Number.parseInt(value, 10);
    const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= USERNAME_COOLDOWN_MAX_DAYS;
    // Dirty means it differs from what is stored, not that somebody typed in it:
    // a value edited and put back leaves Save alone.
    const dirty = valid && parsed !== days;

    function save() {
        setError(null);
        setSaved(false);
        startTransition(async () => {
            const result = await setUsernameCooldownAction(parsed);
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(true);
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">Changing a username</h2>
                    <p className="max-w-xl text-sm text-muted-foreground">
                        Other people find and address each other by their username, so changing one
                        costs a wait. Accounts that have never changed theirs can do it once
                        straight away.
                    </p>
                </div>

                <label className="flex max-w-[12rem] flex-col gap-1 text-sm">
                    <span className="font-medium">
                        Wait between changes <span aria-hidden="true">*</span>
                    </span>
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={USERNAME_COOLDOWN_MAX_DAYS}
                        value={value}
                        aria-label="Days an account waits between username changes"
                        aria-invalid={value.trim() !== "" && !valid}
                        onChange={(event) => setValue(event.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">
                        {parsed === 0 && valid
                            ? "Days. Zero lets anybody change theirs whenever they like."
                            : "Days."}
                    </span>
                </label>

                {error && <p className="text-sm text-danger">{error}</p>}
                {saved && !dirty && <p className="text-sm text-muted-foreground">Saved.</p>}

                <Button className="self-start" size="sm" disabled={!dirty || pending} onClick={save}>
                    Save
                </Button>
            </CardBody>
        </Card>
    );
}
