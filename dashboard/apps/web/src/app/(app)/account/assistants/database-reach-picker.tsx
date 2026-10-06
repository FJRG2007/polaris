"use client";

/**
 * Which databases a connected app's database tools may reach: every one the
 * person can open, or the ones they tick. Drawn inside the permissions dialog
 * while the app holds a database permission. Pure display: the caller holds
 * the choice.
 *
 * A database the grant names that the person can no longer open is not
 * listed - the server would refuse it anyway - and saving drops it.
 */

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Checkbox, Input, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DatabaseReach } from "@/lib/mcp/oauth/database-reach";

/** A database as the picker lists it: never an address or a login. */
export interface DatabaseOption {
    readonly id: string;
    readonly name: string;
    readonly engine: string;
    /** The project and environment of one Polaris runs; null for a saved one. */
    readonly project: string | null;
}

/** More databases than this and the list gets a search box. */
const SEARCH_FROM = 8;

export function DatabaseReachPicker({
    databases,
    reach,
    onChange
}: {
    databases: readonly DatabaseOption[];
    reach: DatabaseReach;
    onChange: (reach: DatabaseReach) => void;
}) {
    const t = useTranslations("mcp");
    const [query, setQuery] = useState("");
    const needle = query.trim().toLowerCase();
    const shown = useMemo(
        () =>
            needle
                ? databases.filter((database) =>
                      [database.name, database.engine, database.project ?? ""].some((value) =>
                          value.toLowerCase().includes(needle)
                      )
                  )
                : databases,
        [databases, needle]
    );
    const chosen = reach ?? [];

    return (
        <fieldset className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
            <legend className="pt-3 text-sm font-medium">
                {t("connectedApps.databases.title")}
            </legend>
            <p className="text-xs text-muted-foreground">{t("connectedApps.databases.hint")}</p>
            {(["all", "chosen"] as const).map((mode) => {
                const active = mode === "all" ? reach === null : reach !== null;
                return (
                    <label
                        key={mode}
                        className={cn(
                            "flex min-w-0 items-start gap-2 rounded-md border border-border p-2.5 text-sm",
                            active && "border-primary/60 bg-primary/5"
                        )}
                    >
                        <input
                            type="radio"
                            name="database-reach"
                            className="mt-1"
                            checked={active}
                            onChange={() => onChange(mode === "all" ? null : chosen)}
                        />
                        <span className="min-w-0">{t(`connectedApps.databases.${mode}`)}</span>
                    </label>
                );
            })}
            {reach !== null ? (
                <div className="flex min-w-0 flex-col gap-2 pl-6">
                    {databases.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("connectedApps.databases.noneToChoose")}
                        </p>
                    ) : null}
                    {databases.length > SEARCH_FROM ? (
                        <span className="relative">
                            <Search
                                className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                                aria-hidden
                            />
                            <Input
                                type="search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t("connectedApps.databases.search")}
                                aria-label={t("connectedApps.databases.search")}
                                autoComplete="off"
                                className="pl-8"
                            />
                        </span>
                    ) : null}
                    <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto overscroll-contain">
                        {shown.map((database) => (
                            <li key={database.id}>
                                <label className="flex min-w-0 items-start gap-2 text-sm">
                                    <Checkbox
                                        checked={chosen.includes(database.id)}
                                        onChange={(event) =>
                                            onChange(
                                                event.target.checked
                                                    ? [...chosen, database.id]
                                                    : chosen.filter((id) => id !== database.id)
                                            )
                                        }
                                        className="mt-0.5"
                                    />
                                    <span className="flex min-w-0 flex-col">
                                        <span className="truncate" title={database.name}>
                                            {database.name}
                                        </span>
                                        <span className="truncate text-xs text-muted-foreground">
                                            {database.project
                                                ? `${database.engine} - ${database.project}`
                                                : database.engine}
                                        </span>
                                    </span>
                                </label>
                            </li>
                        ))}
                    </ul>
                    {databases.length > 0 && chosen.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("connectedApps.databases.noneChosen")}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </fieldset>
    );
}
