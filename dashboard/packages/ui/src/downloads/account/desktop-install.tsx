"use client";

/**
 * The Install button an install line grows inside the desktop app: the app runs
 * the same script, so nobody pastes anything.
 *
 * Feature-detected: in a browser, and in an app older than the button, there is
 * no such method and the line to paste is what is offered.
 */

import { Button } from "../../index";
import { useEffect, useState } from "react";
import { useTranslations } from "../../i18n";
import type { InstallPlatform } from "./install-platform";

export type DesktopTool = "extension" | "cli" | "deck";

type InstallResult = { ok: true } | { ok: false; reason: string; said?: string };

interface DesktopInstaller {
    readonly platform: string;
    installTool?(input: { tool: DesktopTool; browser?: string }): Promise<InstallResult>;
    defaultBrowser?(): Promise<string | null>;
}

/** The desktop app's bridge, when this page runs inside it. */
export function desktopInstaller(): DesktopInstaller | null {
    if (typeof window === "undefined") return null;
    return (window as { polarisDesktop?: DesktopInstaller }).polarisDesktop ?? null;
}

const SYSTEMS: Readonly<Record<string, InstallPlatform>> = {
    win32: "windows",
    darwin: "macos",
    linux: "linux"
};

export function DesktopInstall({
    tool,
    platform,
    browser,
    done
}: {
    tool: DesktopTool;
    /** The system a line on screen is for, when there is one: the button only works on
     *  this one. Left out, it is this computer. */
    platform?: InstallPlatform;
    browser?: string;
    /** What is left to do once it is installed. */
    done: string;
}) {
    const t = useTranslations("account");
    // Read after mounting: there is no bridge on the server.
    const [offered, setOffered] = useState(false);
    const [state, setState] = useState<"idle" | "running" | "done">("idle");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const bridge = desktopInstaller();
        const system = SYSTEMS[bridge?.platform ?? ""];
        setOffered(Boolean(bridge?.installTool) && system !== undefined && (!platform || system === platform));
    }, [platform]);

    if (!offered) return null;

    async function install() {
        setState("running");
        setError(null);
        const result = await desktopInstaller()
            ?.installTool?.({ tool, browser })
            .catch((): InstallResult => ({ ok: false, reason: "failed" }));
        if (result?.ok) {
            setState("done");
            return;
        }
        setState("idle");
        if (!result || result.reason === "cancelled") return;
        if (result.said) setError(result.said);
        else if (result.reason === "unsupported") setError(t("downloads.install.unsupported"));
        else if (result.reason === "busy") setError(t("downloads.install.busy"));
        else setError(t("downloads.install.failed"));
    }

    return (
        <div className="flex flex-col gap-2">
            <Button className="w-fit" disabled={state === "running"} onClick={() => void install()}>
                {state === "running"
                    ? t("downloads.install.running")
                    : t("downloads.install.action")}
            </Button>
            {state === "done" ? <p className="text-xs text-foreground">{done}</p> : null}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}
