"use client";

/**
 * Whether an account may pick its own theme.
 *
 * On by default. Which theme somebody reads a screen in for eight hours is
 * theirs to decide, and an instance that wants one look everywhere - a kiosk, a
 * screen on a wall, a company with a house style - turns it off, and every
 * account follows the default above.
 *
 * Turning it off does not clear what anybody chose. Turning it back on gives
 * everybody their theme back rather than resetting the instance to one palette
 * and leaving people to pick again.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { setThemePolicyAction } from "./actions";
import { Card, CardBody, Switch } from "@polaris/ui";

export function ThemePolicyCard({ allowed }: { allowed: boolean }) {
    const router = useRouter();
    const [on, setOn] = useState(allowed);
    const [error, setError] = useState("");

    return (
        <Card className="mt-4">
            <CardBody className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium">Let people choose their own theme</p>
                    <p className="text-xs text-muted-foreground">
                        Off, every account follows the theme above. What anybody already chose is
                        kept and comes back if you turn this on again.
                    </p>
                    {error && (
                        <p role="alert" className="mt-1 text-xs text-danger">
                            {error}
                        </p>
                    )}
                </div>
                <Switch
                    checked={on}
                    aria-label="Let people choose their own theme"
                    onChange={(next) => {
                        // Moved now and rolled back if the write is refused: a
                        // switch that waits for a round trip reads as broken.
                        setOn(next);
                        setError("");
                        void runAction(() => setThemePolicyAction(next), setError).then((result) => {
                            if (!result || result.error) {
                                setOn(!next);
                                return;
                            }
                            router.refresh();
                        });
                    }}
                />
            </CardBody>
        </Card>
    );
}
