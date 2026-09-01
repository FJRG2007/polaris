"use client";

/**
 * Switching one capability on or off for one person.
 *
 * Roles answer "what does somebody like this do", and that is the right question
 * almost always. This is for the exception: one person who needs the chat and
 * whose role does not carry it, one person who must not have it and whose role
 * does. Without it the only way to say that is a new role, which is how an
 * instance ends up with nine of them and nobody able to say what any means.
 *
 * Three states, not a switch. "Follow their role" is a real answer and is not
 * the same as off - an account with no override moves when the role moves, which
 * is the whole point of having roles - so a two-state control would quietly turn
 * every capability into a decision somebody never made the moment they touched
 * one.
 *
 * Grouped by area and starting collapsed on everything except what is already
 * overridden: twenty-eight capabilities is a wall, and the ones that have been
 * changed are the ones somebody came here to see.
 */

import type { CapabilityState } from "./actions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { setUserPermissionAction, userCapabilitiesAction } from "./actions";
import { Card, CardBody, SegmentedControl, Skeleton, cn } from "@polaris/ui";

type State = "inherit" | "allow" | "deny";

export function CapabilitiesCard({ userId, onSaved }: { userId: string; onSaved: () => void }) {
    const [capabilities, setCapabilities] = useState<readonly CapabilityState[] | null>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(() => {
        void userCapabilitiesAction(userId).then((result) => {
            if (result.error) {
                setError(result.error);
                return;
            }
            setError("");
            setIsAdmin(result.isAdmin ?? false);
            setCapabilities(result.capabilities ?? []);
        });
    }, [userId]);

    useEffect(load, [load]);

    const areas = useMemo(() => {
        const grouped = new Map<string, CapabilityState[]>();
        for (const capability of capabilities ?? []) {
            const bucket = grouped.get(capability.area);
            if (bucket) bucket.push(capability);
            else grouped.set(capability.area, [capability]);
        }
        return [...grouped];
    }, [capabilities]);

    const set = async (permission: string, state: State) => {
        setBusy(permission);
        const result = await setUserPermissionAction(userId, permission, state);
        setBusy(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        load();
        onSaved();
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">Capabilities</h2>
                    <p className="mt-1 text-[0.8125rem] text-muted-foreground">
                        What this account may do, one thing at a time. Each follows their role
                        unless it is set here.
                    </p>
                </div>

                {isAdmin && (
                    <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                        This account is an administrator, which allows everything. Anything switched
                        off here takes effect only if that is taken away first.
                    </p>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                {capabilities === null ? (
                    <div className="flex flex-col gap-2" aria-hidden="true">
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-8 w-full" />
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        {areas.map(([area, entries]) => (
                            <section key={area} className="flex flex-col gap-1.5">
                                <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                    {area}
                                </h3>
                                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                                    {entries.map((capability) => (
                                        <li
                                            key={capability.permission}
                                            className="flex flex-wrap items-center gap-2 px-3 py-2"
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-[0.8125rem]">
                                                    {capability.label}
                                                </span>
                                                <span className="block font-mono text-[0.6875rem] text-foreground-subtle">
                                                    {capability.permission}
                                                </span>
                                            </span>
                                            <span
                                                className={cn(
                                                    "shrink-0 text-[0.6875rem]",
                                                    capability.inherited
                                                        ? "text-muted-foreground"
                                                        : "text-foreground-subtle"
                                                )}
                                            >
                                                {capability.inherited
                                                    ? "role allows"
                                                    : "role does not"}
                                            </span>
                                            <SegmentedControl
                                                size="sm"
                                                value={capability.override ?? "inherit"}
                                                aria-label={`${capability.label} for this account`}
                                                onValueChange={(next) =>
                                                    void set(capability.permission, next as State)
                                                }
                                                options={[
                                                    {
                                                        value: "inherit",
                                                        label: "Role",
                                                        title: "Follow their role and policies",
                                                        disabled: busy === capability.permission
                                                    },
                                                    {
                                                        value: "allow",
                                                        label: "On",
                                                        title: "Always on for this account",
                                                        disabled: busy === capability.permission
                                                    },
                                                    {
                                                        value: "deny",
                                                        label: "Off",
                                                        title: "Always off, whatever their role says",
                                                        disabled: busy === capability.permission
                                                    }
                                                ]}
                                            />
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))}
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
