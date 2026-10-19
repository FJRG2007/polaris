/**
 * Generate `src/lib/minecraft/world-builds/legacy-blocks.json`, the table the
 * converter turns a pre-1.13 MCEdit `.schematic` with (numeric block id and data
 * value per cell) into today's block states.
 *
 * Source: PrismarineJS minecraft-data, `data/pc/common/legacy.json`, at commit
 * 201ca802a1b2c968b02e7fa5b31dd74e8bff3d8b (the file itself last changed in
 * 11fed0c9126d8a4f9a72ee4809f66d996f503688).
 * https://github.com/PrismarineJS/minecraft-data
 * License: MIT (stated in that repository's README).
 *
 * Only its `blocks` half is kept - items never appear in a schematic's block
 * array. The output maps each numeric id to its states indexed by data value,
 * `null` where that data value has no entry, with the `minecraft:` namespace
 * left off to keep the file small. One correction is applied: the dataset gives
 * every stair `shape=outer_right`, a shape the game derives from neighbours;
 * the flattening itself writes `straight`, so that is what is kept.
 *
 * Run from dashboard/apps/game-servers: `node scripts/legacy-blocks.mjs`.
 */

import { writeFile } from "node:fs/promises";

const COMMIT = "201ca802a1b2c968b02e7fa5b31dd74e8bff3d8b";
const SOURCE = `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/${COMMIT}/data/pc/common/legacy.json`;
const TARGET = new URL("../src/lib/minecraft/world-builds/legacy-blocks.json", import.meta.url);
const STATE = /^minecraft:[a-z0-9_]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/;

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`);
const { blocks } = await response.json();

const table = {};
for (const [key, state] of Object.entries(blocks)) {
    const [id, data] = key.split(":").map(Number);
    if (!(id >= 0 && id <= 4095 && data >= 0 && data <= 15) || !STATE.test(state))
        throw new Error(`unexpected entry ${key} = ${state}`);
    const kept = /_stairs\[/.test(state) ? state.replace(/shape=[a-z_]+/, "shape=straight") : state;
    (table[id] ??= [])[data] = kept.slice("minecraft:".length);
}
for (const states of Object.values(table))
    for (let data = 0; data < states.length; data += 1) states[data] ??= null;

// Laid out the way the repository's formatter lays JSON out: an id's states on
// one line when they fit in 100 columns, one per line when they do not.
const lines = Object.entries(table).map(([id, states]) => {
    const flat = `    "${id}": [${states.map((one) => JSON.stringify(one)).join(", ")}]`;
    if (flat.length <= 100) return flat;
    const each = states.map((one) => `        ${JSON.stringify(one)}`);
    return `    "${id}": [\n${each.join(",\n")}\n    ]`;
});
await writeFile(TARGET, `{\n${lines.join(",\n")}\n}\n`);
console.log(`${Object.keys(table).length} ids, ${Object.keys(blocks).length} states`);
