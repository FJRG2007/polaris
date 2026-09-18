"use client";

/**
 * Picking a database engine, the way a service is picked in Apps: the project's
 * own mark beside its own name.
 *
 * One list rather than one per screen - starting a database Polaris runs and
 * connecting to one somewhere else are the same choice, and the screen that
 * offered a plain list of words looked like a different product.
 */

import { Select, type SelectOption } from "@polaris/ui";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { MANAGED_ENGINE_INFO, type ManagedEngine } from "@polaris/core";

/** The options for a Select, marks included. */
export function dbEngineOptions(engines: readonly ManagedEngine[]): SelectOption[] {
    return engines.map((engine) => ({
        value: engine,
        label: MANAGED_ENGINE_INFO[engine].label,
        icon: <DbEngineIcon engine={engine} className="size-5" />
    }));
}

export function DbEngineSelect({
    engines,
    value,
    onValueChange,
    label = "Engine",
    className
}: {
    engines: readonly ManagedEngine[];
    value: string;
    onValueChange: (engine: string) => void;
    /** What a screen reader calls it. */
    label?: string;
    className?: string;
}) {
    return (
        <Select
            value={value}
            onValueChange={onValueChange}
            options={dbEngineOptions(engines)}
            aria-label={label}
            className={className}
        />
    );
}
