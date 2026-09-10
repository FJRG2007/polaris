"use client";

/**
 * What the dashboard draws only inside the Polaris desktop app: the service
 * panel's "follow logs in a window" and "push from this computer". In a browser
 * there is no bridge and none of it renders - a button that could only fail is
 * not offered. See `lib/desktop-bridge.ts` for the bridge itself.
 */

import { useToast } from "@polaris/ui";
import { useSyncExternalStore } from "react";
import { MonitorUp, ScrollText } from "lucide-react";
import { desktopBridge, type DesktopOutcome, type PolarisDesktop } from "@/lib/desktop-bridge";

const never = () => () => undefined;

/** The desktop app's bridge once the page is running in it, null in a browser
 *  and on the server - so the first render matches what the server sent. */
export function useDesktopBridge(): PolarisDesktop | null {
    return useSyncExternalStore(never, desktopBridge, () => null);
}

const ICON_BUTTON =
    "rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

/** The desktop-only actions for one service, beside the panel's own controls. */
export function DesktopServiceActions({
    projectId,
    projectName,
    serviceId,
    serviceName,
    canReadLogs,
    canDeploy
}: {
    projectId: string;
    projectName: string;
    serviceId: string;
    serviceName: string;
    canReadLogs: boolean;
    canDeploy: boolean;
}) {
    const bridge = useDesktopBridge();
    const toast = useToast();
    if (!bridge) return null;
    // Named as the dashboard's own deploy alert names it, so the notice the app
    // raises for a push and the dashboard's alert for the same deploy match.
    const label = `${projectName} / ${serviceName}`;
    const report = (outcome: DesktopOutcome) => {
        if (!outcome.ok) toast.show({ title: outcome.error });
    };

    return (
        <>
            {canReadLogs && (
                <button
                    type="button"
                    onClick={() =>
                        void bridge
                            .openWindow({ path: `/apps/deploy/${projectId}/logs?service=${serviceId}`, title: `Logs - ${label}` })
                            .then(report)
                    }
                    aria-label="Follow logs in a window"
                    title="Follow logs in a window"
                    className={ICON_BUTTON}
                >
                    <ScrollText className="size-4" />
                </button>
            )}
            {canDeploy && (
                <button
                    type="button"
                    onClick={() =>
                        void bridge
                            .pushLocal({ serviceId, name: label, href: `/apps/deploy/${projectId}?service=${serviceId}` })
                            .then(report)
                    }
                    aria-label="Push from this computer"
                    title="Push from this computer - build with its Docker and deploy the image"
                    className={ICON_BUTTON}
                >
                    <MonitorUp className="size-4" />
                </button>
            )}
        </>
    );
}
