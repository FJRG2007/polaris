"use client";

/**
 * "Use my location": asks this browser where it is and hands back the answer
 * rounded to about a kilometre, which is all the sun needs and all a place
 * keeps. The rounding happens here, before the coordinate leaves the browser,
 * and again on the server.
 *
 * A refusal or a failure is said under the button, in words, and the button
 * stays there to try again; nothing else on the screen depends on it.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { usePlacesT } from "./use-places-t";
import { Loader2, LocateFixed } from "lucide-react";
import { roundCoordinate, type Coordinate } from "@polaris/core";

/** Geolocation's own code for "the person said no". */
const PERMISSION_DENIED = 1;

export function UseLocationButton({
    onLocated,
    disabled
}: {
    /** Given the rounded coordinate. A thrown error or a returned message is
     *  shown under the button. */
    onLocated: (location: Coordinate) => Promise<string | void> | string | void;
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const locate = () => {
        const geolocation = typeof navigator === "undefined" ? undefined : navigator.geolocation;
        if (!geolocation) {
            setError(t("location.unsupported"));
            return;
        }
        setBusy(true);
        setError(null);
        geolocation.getCurrentPosition(
            (position) => {
                void (async () => {
                    try {
                        const said = await onLocated(
                            roundCoordinate({
                                latitude: position.coords.latitude,
                                longitude: position.coords.longitude
                            })
                        );
                        if (said) setError(said);
                    } catch {
                        setError(t("location.failed"));
                    } finally {
                        setBusy(false);
                    }
                })();
            },
            (failure) => {
                setBusy(false);
                setError(
                    t(failure.code === PERMISSION_DENIED ? "location.denied" : "location.failed")
                );
            },
            // A kilometre is the most that is kept, so a coarse fix is plenty
            // and a recent one will do.
            { enableHighAccuracy: false, timeout: 15_000, maximumAge: 10 * 60_000 }
        );
    };

    return (
        <div className="flex min-w-0 flex-col items-start gap-1.5">
            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={locate}
                disabled={disabled || busy}
            >
                {busy ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : (
                    <LocateFixed className="size-4 shrink-0" />
                )}
                {busy ? t("location.locating") : t("location.use")}
            </Button>
            {error ? (
                <p role="alert" className="text-[0.75rem] text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
