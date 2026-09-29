"use client";

/** A gathering's settings: the material it is for, or one drawn each time. */

import { Select } from "@polaris/ui";
import { Field, options } from "./event-editor";
import { useGameText } from "../game-text";
import type { GameKey } from "../../../messages";
import type * as catalog from "../../lib/minecraft/events/catalog";

type Value = catalog.EventOptions<"gathering">;

export const MATERIAL_LABELS: Readonly<Record<Value["material"], GameKey<"minecraft">>> = {
    random: "events.materials.random",
    wheat: "events.materials.wheat",
    logs: "events.materials.logs",
    cobblestone: "events.materials.cobblestone",
    iron_ingot: "events.materials.iron_ingot",
    coal: "events.materials.coal",
    kelp: "events.materials.kelp",
    bamboo: "events.materials.bamboo",
    sugar_cane: "events.materials.sugar_cane",
    potato: "events.materials.potato",
    carrot: "events.materials.carrot",
    sand: "events.materials.sand",
    pumpkin: "events.materials.pumpkin"
};

export function GatheringOptions({
    value,
    onChange
}: {
    value: Value;
    onChange: (next: Value) => void;
}) {
    const t = useGameText("minecraft");
    return (
        <Field label={t("editor.material")} hint={t("editor.materialHint")}>
            <Select
                value={value.material}
                onValueChange={(material) =>
                    onChange({ ...value, material: material as Value["material"] })
                }
                options={options(t, MATERIAL_LABELS)}
                aria-label={t("editor.material")}
            />
        </Field>
    );
}
