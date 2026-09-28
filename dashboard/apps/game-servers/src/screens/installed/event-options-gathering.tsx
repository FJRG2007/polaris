"use client";

/** A gathering's settings: the material it is for, or one drawn each time. */

import { Select } from "@polaris/ui";
import { Field, options } from "./event-editor";
import type * as catalog from "../../lib/minecraft/events/catalog";

type Value = catalog.EventOptions<"gathering">;

export const MATERIAL_LABELS: Readonly<Record<Value["material"], string>> = {
    random: "Drawn at random each time",
    wheat: "Wheat",
    logs: "Logs, any wood",
    cobblestone: "Cobblestone",
    iron_ingot: "Iron ingots (smelted)",
    coal: "Coal",
    kelp: "Kelp",
    bamboo: "Bamboo (1.14+)",
    sugar_cane: "Sugar cane",
    potato: "Potatoes",
    carrot: "Carrots",
    sand: "Sand",
    pumpkin: "Pumpkins"
};

export function GatheringOptions({
    value,
    onChange
}: {
    value: Value;
    onChange: (next: Value) => void;
}) {
    return (
        <Field
            label="Material"
            hint="Announced when the countdown starts. Only what is gathered during the event counts."
        >
            <Select
                value={value.material}
                onValueChange={(material) =>
                    onChange({ ...value, material: material as Value["material"] })
                }
                options={options(MATERIAL_LABELS)}
                aria-label="Material"
            />
        </Field>
    );
}
