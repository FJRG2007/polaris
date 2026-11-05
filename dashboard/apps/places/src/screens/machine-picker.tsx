"use client";

/**
 * The one way a Places screen picks a machine: the house owner's servers read a
 * page at a time and searched on the server, so a house whose owner runs
 * thousands of them opens the dialog as fast as one with a single server.
 */

import { usePlacesT } from "./use-places-t";
import * as actions from "./actions";
import { hostUi } from "@polaris/app-host/client";

const { PagedPicker } = hostUi.pagedPicker;

export function MachinePicker({
    value,
    onValueChange,
    includeLocal = false,
    fixed,
    className,
    disabled
}: {
    value: string | null;
    onValueChange: (id: string) => void;
    /** Offer the machine Polaris runs on first, as `local`. */
    includeLocal?: boolean;
    /** Choices above the machines, such as reaching the camera directly. */
    fixed?: readonly { value: string; label: string }[];
    className?: string;
    disabled?: boolean;
}) {
    const t = usePlacesT();
    return (
        <PagedPicker<actions.MachineOption>
            read={actions.machineOptionsAction}
            scope={{ includeLocal }}
            cache="places:machines"
            value={value}
            onValueChange={(id) => onValueChange(id)}
            itemDetail={(machine) => machine.address || null}
            fixed={fixed}
            className={className}
            disabled={disabled}
            placeholder={t("machinePicker.placeholder")}
            searchPlaceholder={t("machinePicker.search")}
            emptyText={t("machinePicker.empty")}
        />
    );
}
