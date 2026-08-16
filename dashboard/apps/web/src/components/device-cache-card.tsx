"use client";

/**
 * Emptying what this browser is holding, without signing out.
 *
 * Almost everything here revalidates on its own, and the one thing that reliably
 * did not - a face, cached for five minutes including the blank one served while
 * a disk was away - now asks every time. This is for the rest: the browser that
 * has ended up holding something out of date and cannot be talked out of it, and
 * the person who should not have to know what a hard reload is, let alone sign
 * out and back in to get one.
 *
 * Nothing that identifies anybody is stored in a browser by Polaris - the
 * session is a cookie, and this does not touch it - so this ends with a reload
 * rather than at the sign-in screen.
 */

import { useState } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

/** Everything Polaris writes into a browser is under this. Deliberately not all
 *  of local storage: this origin is the sign-in surface too, and clearing what
 *  belongs to somebody else is how a helpful button signs you out. */
const OURS = "polaris.";

export function DeviceCacheCard() {
    const [clearing, setClearing] = useState(false);

    const clear = async (): Promise<void> => {
        setClearing(true);
        try {
            for (const key of Object.keys(window.localStorage)) {
                if (key.startsWith(OURS)) window.localStorage.removeItem(key);
            }
            window.sessionStorage.clear();

            // Whatever the browser has stored under this origin, and anything
            // registered to answer requests from it. Both are absent on most
            // installs, and both are exactly what survives an ordinary reload.
            if ("caches" in window) {
                const names = await caches.keys();
                await Promise.all(names.map((name) => caches.delete(name)));
            }
            if ("serviceWorker" in navigator) {
                const workers = await navigator.serviceWorker.getRegistrations();
                await Promise.all(workers.map((worker) => worker.unregister()));
            }
        } catch {
            // A browser with storage disabled, or a quota error on the way out.
            // The reload below is still worth doing.
        }
        window.location.reload();
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>This device</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    Polaris keeps a few things in this browser so screens open faster - pictures,
                    how loud each person is in a call, playback speed. Clear them if something looks
                    out of date and a reload has not fixed it. Your other devices are not affected,
                    and you stay signed in.
                </p>
                <div>
                    <Button variant="secondary" disabled={clearing} onClick={() => void clear()}>
                        {clearing ? "Clearing" : "Clear cached data"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
