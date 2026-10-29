"use client";

/**
 * The desktop app's "restart to update", in the top bar beside the bell: a
 * green download icon that appears once the app has downloaded and installed a
 * new version, and restarts into it on a press. Nothing renders in a browser,
 * in an app older than the feature, or while no update is waiting - a check or
 * a download in progress is the app's business, not a button.
 */

import { useToast } from "@polaris/ui";
import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useDesktopBridge } from "@/components/desktop-app";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { readDesktopUpdate, type DesktopUpdate } from "@/lib/desktop-bridge";

/** How long the button waits on a restart that did not happen - the quit was
 *  turned down, a push still running - before it can be pressed again. */
export const RESTART_WAIT_MS = 15_000;

export function DesktopUpdateButton() {
    const t = useTranslations("components");
    const bridge = useDesktopBridge();
    const toast = useToast();
    const [update, setUpdate] = useState<DesktopUpdate | null>(null);
    const [pending, setPending] = useState(false);

    useEffect(() => {
        if (!bridge?.updateReady || !bridge.onUpdateReady || !bridge.installUpdate) return;
        let active = true;
        // What the app says after this page asked is newer than the answer.
        let heard = false;
        const stop = bridge.onUpdateReady((raw) => {
            heard = true;
            setUpdate(readDesktopUpdate(raw));
        });
        bridge
            .updateReady()
            .then((raw) => {
                if (active && !heard) setUpdate(readDesktopUpdate(raw));
            })
            .catch(() => undefined);
        return () => {
            active = false;
            stop();
        };
    }, [bridge]);

    useEffect(() => {
        if (!pending) return;
        const timer = setTimeout(() => setPending(false), RESTART_WAIT_MS);
        return () => clearTimeout(timer);
    }, [pending]);

    if (!bridge?.installUpdate || !update) return null;
    const install = bridge.installUpdate;
    const label = t("desktopUpdate.label", { version: update.version });

    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-busy={pending || undefined}
            disabled={pending}
            onClick={() => {
                setPending(true);
                install()
                    .then((outcome) => {
                        if (outcome.ok) return;
                        setPending(false);
                        toast.show({ title: outcome.error });
                    })
                    .catch(() => {
                        setPending(false);
                        toast.show({ title: t("desktopUpdate.failed") });
                    });
            }}
            className="grid size-8 shrink-0 place-items-center rounded-full text-success transition-colors hover:bg-success-soft disabled:cursor-wait"
        >
            {pending ? (
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            ) : (
                <Download className="size-4 shrink-0" aria-hidden />
            )}
        </button>
    );
}
