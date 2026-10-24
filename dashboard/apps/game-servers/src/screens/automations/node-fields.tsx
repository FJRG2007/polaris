"use client";

/**
 * The settings of a Game servers step in the central automation editor: which
 * server, and what to do to it or which console line to send.
 *
 * The server list is the one the signed-in account could act on from the
 * server's page; the run asks again as the run-as account.
 */

import { useEffect, useState } from "react";
import { Select, Skeleton } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { useGameText } from "../game-text";
import { automationServersAction } from "../actions";
import { COMMAND_NODE_TYPE, POWER_ACTIONS } from "../../lib/automation-node-types";

const { RefInput } = hostUi.automationsReferences;

/** What the central editor hands a Game servers node's fields. */
export interface GameNodeFieldsProps {
    readonly node: { readonly id: string; readonly type: string; readonly config?: unknown };
    readonly setConfig: (config: unknown) => void;
    readonly disabled?: boolean;
}

type Server = { id: string; name: string };

export function GameNodeFields({ node, setConfig, disabled = false }: GameNodeFieldsProps) {
    const t = useGameText("games");
    const console_ = node.type === COMMAND_NODE_TYPE;
    const [servers, setServers] = useState<Server[] | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        void automationServersAction(console_ ? "games.console" : "games.manage").then(
            (answer) => {
                if (cancelled) return;
                if (answer.servers) setServers(answer.servers);
                else setError(answer.error ?? "");
            },
            () => !cancelled && setError(t("errors.couldNotChangeTheServer"))
        );
        return () => {
            cancelled = true;
        };
    }, [console_]);

    const config = (node.config ?? {}) as Record<string, unknown>;
    const set = (change: Record<string, unknown>) => setConfig({ ...config, ...change });
    const installId = typeof config.installId === "string" ? config.installId : "";
    const action = typeof config.action === "string" ? config.action : "start";

    // A step just added has no action yet: start it on "Start".
    useEffect(() => {
        if (!console_ && !disabled && typeof config.action !== "string") set({ action: "start" });
    }, [node.id]);

    const missing =
        servers !== null && installId !== "" && !servers.some((s) => s.id === installId);

    return (
        <div className="space-y-3">
            <label className="block space-y-1">
                <span className="text-xs font-medium">{`${t("automation.server")} *`}</span>
                {servers === null && !error ? (
                    <Skeleton className="h-9 w-full" />
                ) : (
                    <Select
                        value={installId}
                        onValueChange={(value) => set({ installId: value })}
                        options={(servers ?? []).map((server) => ({
                            value: server.id,
                            label: server.name
                        }))}
                        placeholder={t("automation.serverPick")}
                        aria-label={t("automation.server")}
                        disabled={disabled}
                    />
                )}
            </label>
            {error && (
                <p role="alert" className="text-xs text-danger-ink">
                    {error}
                </p>
            )}
            {servers !== null && servers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    {t(console_ ? "automation.consoleNone" : "automation.serverNone")}
                </p>
            )}
            {missing && <p className="text-xs text-danger-ink">{t("automation.serverGone")}</p>}
            {console_ ? (
                <label className="block space-y-1">
                    <span className="text-xs font-medium">{`${t("automation.command")} *`}</span>
                    <RefInput
                        value={typeof config.command === "string" ? config.command : ""}
                        onChange={(event) => set({ command: event.target.value })}
                        maxLength={2000}
                        disabled={disabled}
                        aria-label={t("automation.command")}
                    />
                    <span className="block min-w-0 break-words text-xs text-muted-foreground">
                        {t("automation.commandHint")}
                    </span>
                </label>
            ) : (
                <label className="block space-y-1">
                    <span className="text-xs font-medium">{t("automation.power")}</span>
                    <Select
                        value={action}
                        onValueChange={(value) => set({ action: value })}
                        options={POWER_ACTIONS.map((value) => ({
                            value,
                            label: t(`automation.${value}`)
                        }))}
                        aria-label={t("automation.power")}
                        disabled={disabled}
                    />
                </label>
            )}
        </div>
    );
}
