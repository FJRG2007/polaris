"use client";

/** A treasure hunt's settings: how many chests, how far out, what is in them. */

import { Input, Select } from "@polaris/ui";
import type * as catalog from "../../lib/minecraft/events/catalog";
import { Field, LOOT_LABELS, numberOf, options, problemAt } from "./event-editor";

type Value = catalog.EventOptions<"treasure-hunt">;

export function TreasureHuntOptions({
    value,
    onChange,
    issues
}: {
    value: Value;
    onChange: (next: Value) => void;
    issues: readonly { path: (string | number)[]; message: string }[];
}) {
    return (
        <>
            <div className="grid grid-cols-2 gap-3">
                <Field
                    label="Chests"
                    hint="1 to 10"
                    problem={problemAt(issues, "options", "chests")}
                >
                    <Input
                        type="number"
                        min={1}
                        max={10}
                        value={Number.isFinite(value.chests) ? value.chests : ""}
                        onChange={(event) =>
                            onChange({ ...value, chests: numberOf(event.target.value) })
                        }
                    />
                </Field>
                <Field
                    label="How far out (blocks)"
                    hint="50 to 1000, from the players"
                    problem={problemAt(issues, "options", "distance")}
                >
                    <Input
                        type="number"
                        min={50}
                        max={1000}
                        value={Number.isFinite(value.distance) ? value.distance : ""}
                        onChange={(event) =>
                            onChange({ ...value, distance: numberOf(event.target.value) })
                        }
                    />
                </Field>
            </div>
            <Field label="What is inside">
                <Select
                    value={value.loot}
                    onValueChange={(loot) => onChange({ ...value, loot: loot as Value["loot"] })}
                    options={options(LOOT_LABELS)}
                    aria-label="What is inside"
                />
            </Field>
        </>
    );
}
