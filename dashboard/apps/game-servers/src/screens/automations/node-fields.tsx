"use client";

/**
 * The settings of a Game servers step in the central automation editor: which
 * server, and what to do to it or which console line to send.
 *
 * The server list is the one the signed-in account could act on from the
 * server's page; the run asks again as the run-as account.
 */

import { useEffect, useState } from "react";
import { Select } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { useGameText } from "../game-text";
import { automationServerOptionsAction } from "../actions";
import { COMMAND_NODE_TYPE, POWER_ACTIONS } from "../../lib/automation-node-types";

const { RefInput } = hostUi.automationsReferences;
const { PagedPicker } = hostUi.pagedPicker;

/** What the central editor hands a Game servers node's fields. */
export interface GameNodeFieldsProps {
    readonly node: { readonly id: string; readonly type: string; readonly config?: unknown };
    readonly setConfig: (config: unknown) => void;
    readonly disabled?: boolean;
}

export function GameNodeFields({ node, setConfig, disabled = false }: GameNodeFieldsProps) {
    const t = useGameText("games");
    const console_ = node.type === COMMAND_NODE_TYPE;
    const permission = console_ ? "games.console" : "games.manage";
    /** Whether there is any server to pick at all, and whether the chosen one is
     *  still among them - each a one-row read, never the whole list. */
    const [none, setNone] = useState(false);
    const [missing, setMissing] = useState(false);
    const [error, setError] = useState("");

    const config = (node.config ?? {}) as Record<string, unknown>;
    const set = (change: Record<string, unknown>) => setConfig({ ...config, ...change });
    const installId = typeof config.installId === "string" ? config.installId : "";

    useEffect(() => {
        let cancelled = false;
        void automationServerOptionsAction({ permission, limit: 1 }).then(
            (answer) => {
                if (cancelled) return;
                if ("error" in answer) setError(answer.error);
                else setNone(answer.items.length === 0);
            },
            () => !cancelled && setError(t("errors.couldNotChangeTheServer"))
        );
        return () => {
            cancelled = true;
        };
    }, [permission]);

    useEffect(() => {
        let cancelled = false;
        setMissing(false);
        if (!/^[0-9a-f-]{36}$/i.test(installId)) {
            setMissing(installId !== "");
            return;
        }
        void automationServerOptionsAction({ permission, ids: [installId] }).then(
            (answer) => !cancelled && !("error" in answer) && setMissing(answer.items.length === 0),
            () => undefined
        );
        return () => {
            cancelled = true;
        };
    }, [permission, installId]);
    const action = typeof config.action === "string" ? config.action : "start";

    // A step just added has no action yet: start it on "Start".
    useEffect(() => {
        if (!console_ && !disabled && typeof config.action !== "string") set({ action: "start" });
    }, [node.id]);

    return (
        <div className="space-y-3">
            <label className="block space-y-1">
                <span className="text-xs font-medium">{`${t("automation.server")} *`}</span>
                <PagedPicker<{ id: string; name: string }>
                    read={automationServerOptionsAction}
                    scope={{ permission }}
                    cache="games:automation-servers"
                    value={installId || null}
                    onValueChange={(id) => set({ installId: id })}
                    placeholder={t("automation.serverPick")}
                    searchPlaceholder={t("automation.serverSearch")}
                    emptyText={t("automation.serverEmpty")}
                    aria-label={t("automation.server")}
                    disabled={disabled}
                />
            </label>
            {error && (
                <p role="alert" className="text-xs text-danger-ink">
                    {error}
                </p>
            )}
            {none && (
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
