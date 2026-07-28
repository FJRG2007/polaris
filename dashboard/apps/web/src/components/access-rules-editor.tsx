"use client";

/**
 * The network-restriction editor shared by the account's sign-in rules and by
 * each API key: reusable access groups, plus rules typed directly on the target.
 * Both surfaces use it so a rule means the same thing wherever it is set, and so
 * the union semantics ("groups plus your own entries") are visible in one place.
 * Controlled - the parent owns the value.
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { ipRuleField } from "@polaris/core";
import { Button, Input, cn } from "@polaris/ui";
import { GeoPicker } from "@/components/geo-picker";

export interface AccessRulesValue {
    groupIds: string[];
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
}

export interface AccessGroupOption {
    id: string;
    name: string;
}

export const EMPTY_ACCESS_RULES: AccessRulesValue = {
    groupIds: [],
    allowedCidrs: [],
    allowedCountries: [],
    allowedContinents: []
};

/** Whether a value imposes any restriction at all, for the summary line. */
export function accessRulesAreEmpty(value: AccessRulesValue): boolean {
    return (
        value.groupIds.length === 0 &&
        value.allowedCidrs.length === 0 &&
        value.allowedCountries.length === 0 &&
        value.allowedContinents.length === 0
    );
}

export function AccessRulesEditor({
    value,
    groups,
    onChange,
    /** Hidden when the editor is itself defining a group's rules. */
    showGroups = true
}: {
    value: AccessRulesValue;
    groups: AccessGroupOption[];
    onChange: (next: AccessRulesValue) => void;
    showGroups?: boolean;
}) {
    const [draft, setDraft] = useState("");
    const [ipError, setIpError] = useState<string | null>(null);

    function addRule() {
        const parsed = ipRuleField.safeParse(draft);
        if (!parsed.success) {
            setIpError(parsed.error.issues[0]?.message ?? "Invalid rule");
            return;
        }
        setIpError(null);
        setDraft("");
        if (value.allowedCidrs.includes(parsed.data)) return;
        onChange({ ...value, allowedCidrs: [...value.allowedCidrs, parsed.data] });
    }

    function toggleGroup(id: string) {
        onChange({
            ...value,
            groupIds: value.groupIds.includes(id)
                ? value.groupIds.filter((groupId) => groupId !== id)
                : [...value.groupIds, id]
        });
    }

    return (
        <div className="flex flex-col gap-3">
            {showGroups ? (
                <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Access groups</span>
                    {groups.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            No groups yet. Create one under Access rules to reuse the same allowlist here.
                        </p>
                    ) : (
                        <div className="flex flex-wrap gap-1.5">
                            {groups.map((group) => (
                                <button
                                    key={group.id}
                                    type="button"
                                    onClick={() => toggleGroup(group.id)}
                                    className={cn(
                                        "rounded-full border px-2.5 py-1 text-xs transition-colors",
                                        value.groupIds.includes(group.id)
                                            ? "border-primary bg-primary/10 text-primary"
                                            : "border-border text-muted-foreground hover:bg-muted"
                                    )}
                                >
                                    {group.name}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            ) : null}

            <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">IP addresses and ranges</span>
                <div className="flex gap-2">
                    <Input
                        value={draft}
                        placeholder="203.0.113.7 or 10.0.0.0/8"
                        autoComplete="off"
                        aria-invalid={Boolean(ipError)}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            setIpError(null);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                addRule();
                            }
                        }}
                    />
                    <Button type="button" variant="ghost" onClick={addRule} disabled={draft.trim() === ""}>
                        <Plus className="size-4" />
                        Add
                    </Button>
                </div>
                {ipError ? <p className="text-xs text-danger">{ipError}</p> : null}
                {value.allowedCidrs.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                        {value.allowedCidrs.map((rule) => (
                            <span
                                key={rule}
                                className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 font-mono text-xs text-primary"
                            >
                                {rule}
                                <button
                                    type="button"
                                    aria-label={`Remove ${rule}`}
                                    onClick={() =>
                                        onChange({
                                            ...value,
                                            allowedCidrs: value.allowedCidrs.filter((entry) => entry !== rule)
                                        })
                                    }
                                >
                                    <X className="size-3" />
                                </button>
                            </span>
                        ))}
                    </div>
                ) : null}
            </div>

            <GeoPicker
                countries={value.allowedCountries}
                continents={value.allowedContinents}
                onCountries={(allowedCountries) => onChange({ ...value, allowedCountries })}
                onContinents={(allowedContinents) => onChange({ ...value, allowedContinents })}
            />
        </div>
    );
}
