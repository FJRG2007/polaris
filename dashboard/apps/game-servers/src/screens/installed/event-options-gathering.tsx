"use client";

/** A gathering's settings: the material of its rounds, or one drawn for each,
 *  how many rounds and how long each lasts. */

import { Input, Select } from "@polaris/ui";
import { Field, numberOf, options, problemAt } from "./event-editor";
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
    onChange,
    issues
}: {
    value: Value;
    onChange: (next: Value) => void;
    issues: readonly { path: (string | number)[]; message: string }[];
}) {
    const t = useGameText("minecraft");
    return (
        <>
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
            <div className="grid grid-cols-2 gap-3">
                <Field
                    label={t("editor.rounds")}
                    hint={t("editor.range", { min: 1, max: 6 })}
                    problem={problemAt(issues, "options", "rounds")}
                >
                    <Input
                        type="number"
                        min={1}
                        max={6}
                        value={Number.isFinite(value.rounds) ? value.rounds : ""}
                        onChange={(event) =>
                            onChange({ ...value, rounds: numberOf(event.target.value) })
                        }
                    />
                </Field>
                <Field
                    label={t("editor.roundMinutes")}
                    hint={t("editor.range", { min: 1, max: 5 })}
                    problem={problemAt(issues, "options", "roundMinutes")}
                >
                    <Input
                        type="number"
                        min={1}
                        max={5}
                        value={Number.isFinite(value.roundMinutes) ? value.roundMinutes : ""}
                        onChange={(event) =>
                            onChange({ ...value, roundMinutes: numberOf(event.target.value) })
                        }
                    />
                </Field>
            </div>
        </>
    );
}
