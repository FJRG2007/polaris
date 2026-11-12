"use client";

/**
 * Who works on a Code task, as every multi-provider composer draws it (VS
 * Code's Copilot, Cursor, Zed): the agent first, one row each - Polar, the
 * coding tools, the person's own agents - then the model, offering only what
 * that agent may use and grouped by the account it signs in with.
 *
 * Both are the composer's chips, in the model picker's place and look; the
 * lists open in a portal with collision handling.
 */

import Link from "next/link";
import { useState } from "react";
import { Bot, Check, KeyRound, Sparkles } from "lucide-react";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuSearch,
    menuSearchMatches
} from "@polaris/ui";
import { AgentLogo } from "@/components/logos";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { settingsSection } from "@/lib/polar/settings-path";
import { MODEL_TRIGGER } from "@/components/polar/elements/model-selector";
import { accountLabel } from "@/app/(app)/polar/settings/agent-work-fields";
import type {
    ComposerAccount,
    ComposerAgent,
    ComposerModel
} from "@/lib/polar/agents/composer-agents";

/** Polar's own row (`composer-agents.ts`). */
const POLAR_AGENT_KEY = "polar";

const MENU =
    "max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain pt-2";

function Mark({ on }: { on: boolean }) {
    return <Check className={cn("ml-auto size-3.5 shrink-0 text-primary", !on && "opacity-0")} />;
}

function AgentMark({ agent, className }: { agent: ComposerAgent; className: string }) {
    if (agent.kind === "polar") return <Sparkles className={className} aria-hidden />;
    if (agent.kind === "custom") return <Bot className={className} aria-hidden />;
    return <AgentLogo id={agent.engine} label={agent.name} className={className} />;
}

/** The agent a task runs as: one row per agent, never one per account. */
export function ComposerAgentPicker({
    agents,
    value,
    onChange,
    disabled
}: {
    /** Null while the choices are on their way. */
    agents: readonly ComposerAgent[] | null;
    value: string;
    onChange: (key: string) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [query, setQuery] = useState("");
    const picked = agents?.find((agent) => agent.key === value) ?? null;
    const shown = (agents ?? []).filter((agent) => menuSearchMatches(agent.name, query));
    const included = shown.filter((agent) => agent.kind !== "custom");
    const own = shown.filter((agent) => agent.kind === "custom");
    const searchable = (agents?.length ?? 0) > 6;
    // Polar is always there, also before its row has loaded.
    const polar = value === POLAR_AGENT_KEY;
    const label = polar ? t("code.polarEngine") : (picked?.name ?? t("code.agent"));

    const row = (agent: ComposerAgent) => (
        <DropdownMenuItem key={agent.key} onSelect={() => onChange(agent.key)} className="items-start">
            <AgentMark agent={agent} className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex min-w-0 flex-col">
                <span className="truncate" title={agent.name}>
                    {agent.kind === "polar" ? t("code.polarEngine") : agent.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                    {agent.kind === "polar"
                        ? t("code.polarEngineHint")
                        : agent.readiness === "missing"
                          ? t("code.notSignedIn")
                          : agent.description || null}
                </span>
            </span>
            <Mark on={agent.key === value} />
        </DropdownMenuItem>
    );

    return (
        <DropdownMenu onOpenChange={(next) => (next ? undefined : setQuery(""))}>
            <DropdownMenuTrigger asChild disabled={disabled || agents === null}>
                <button
                    type="button"
                    title={label}
                    aria-label={`${t("code.agent")}: ${label}`}
                    className={cn(MODEL_TRIGGER, "disabled:opacity-60")}
                >
                    {polar ? (
                        <Sparkles className="size-3.5 shrink-0" aria-hidden />
                    ) : picked ? (
                        <AgentMark agent={picked} className="size-3.5 shrink-0" />
                    ) : (
                        <Bot className="size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="truncate text-foreground" title={label}>{label}</span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className={MENU}>
                {searchable ? (
                    <MenuSearch value={query} onChange={setQuery} placeholder={t("code.searchAgents")} />
                ) : null}
                {included.length > 0 ? <DropdownMenuLabel>{t("code.agent")}</DropdownMenuLabel> : null}
                {included.map(row)}
                {own.length > 0 ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t("code.yourAgents")}</DropdownMenuLabel>
                        {own.map(row)}
                    </>
                ) : null}
                {searchable && query.trim() && shown.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        {t("code.noAgentMatch")}
                    </p>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href={settingsSection("agents")}>{t("code.editAgents")}</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <Link href="/account/ai-keys">{t("code.apiKeys")}</Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The models a tool with a model of its own offers: the agent's list, kept
 *  to when it must be, else the list first and then the rest. */
export function toolModels(agent: ComposerAgent): ComposerModel[] {
    const named = (provider: string, model: string) =>
        agent.catalogue.find((entry) => entry.provider === provider && entry.model === model)?.name ??
        model;
    const listed = agent.models.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        name: named(entry.provider, entry.model)
    }));
    if (agent.modelPolicy === "required" && listed.length > 0) return listed;
    return [
        ...listed,
        ...agent.catalogue.filter(
            (entry) => !listed.some((other) => other.model === entry.model)
        )
    ];
}

/** An account and a model on it, as a task on a tool starts. `model` null is
 *  whatever the account uses by default. */
export interface AccountModelPick {
    account: string;
    model: string | null;
}

/** The model a tool runs, grouped by the account it signs in with. */
export function AccountModelPicker({
    agent,
    value,
    onChange,
    disabled
}: {
    agent: ComposerAgent;
    value: AccountModelPick | null;
    onChange: (pick: AccountModelPick) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [query, setQuery] = useState("");
    const models = agent.modelSource === "own" ? toolModels(agent) : [];
    const accounts = agent.accounts;
    const account = accounts.find((entry) => entry.key === value?.account) ?? null;
    const modelName = value?.model
        ? (models.find((entry) => entry.model === value.model)?.name ?? value.model)
        : null;
    const accountText = (entry: ComposerAccount) => accountLabel(entry, t);
    const shownModels = models.filter((entry) => menuSearchMatches(entry.name, query));
    const searchable = models.length > 8;
    const trigger = [modelName ?? (agent.modelSource === "own" ? t("code.accountDefault") : null), account ? accountText(account) : null]
        .filter(Boolean)
        .join(" - ");

    return (
        <DropdownMenu onOpenChange={(next) => (next ? undefined : setQuery(""))}>
            <DropdownMenuTrigger asChild disabled={disabled || accounts.length === 0}>
                <button
                    type="button"
                    title={trigger}
                    aria-label={`${t("code.model")}: ${trigger}`}
                    className={cn(MODEL_TRIGGER, "disabled:opacity-60")}
                >
                    <KeyRound className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate text-foreground">{trigger}</span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className={MENU}>
                {searchable ? (
                    <MenuSearch value={query} onChange={setQuery} placeholder={t("picker.search")} />
                ) : null}
                {accounts.map((entry, index) => (
                    <div key={entry.key}>
                        {index > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel className="truncate" title={accountText(entry)}>
                            {accountText(entry)}
                            {entry.readiness === "missing" ? ` - ${t("code.notSignedIn")}` : ""}
                        </DropdownMenuLabel>
                        {query.trim() ? null : (
                            <DropdownMenuItem
                                onSelect={() => onChange({ account: entry.key, model: null })}
                            >
                                <span className="min-w-0 truncate">
                                    {agent.modelSource === "own"
                                        ? t("code.accountDefault")
                                        : accountText(entry)}
                                </span>
                                <Mark on={value?.account === entry.key && value.model === null} />
                            </DropdownMenuItem>
                        )}
                        {shownModels.map((model) => (
                            <DropdownMenuItem
                                key={model.model}
                                onSelect={() => onChange({ account: entry.key, model: model.model })}
                            >
                                <span className="min-w-0 truncate" title={model.name}>
                                    {model.name}
                                </span>
                                <Mark on={value?.account === entry.key && value.model === model.model} />
                            </DropdownMenuItem>
                        ))}
                    </div>
                ))}
                {searchable && query.trim() && shownModels.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        {t("picker.noMatch")}
                    </p>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href={settingsSection("agents")}>{t("code.editAgents")}</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <Link href="/account/ai-keys">{t("picker.manage")}</Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The pick a task on a tool opens on: the agent's preferred model on the
 *  first account that is signed in. */
export function defaultAccountPick(agent: ComposerAgent): AccountModelPick | null {
    const account =
        agent.accounts.find((entry) => entry.readiness === "ready") ??
        agent.accounts.find((entry) => entry.readiness === "unknown") ??
        agent.accounts[0];
    if (!account) return null;
    const first = agent.modelSource === "own" ? agent.models[0] : undefined;
    return { account: account.key, model: first?.model ?? null };
}
