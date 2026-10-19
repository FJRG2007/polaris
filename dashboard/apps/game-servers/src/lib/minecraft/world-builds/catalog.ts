/**
 * The seasonal builds Polaris places in a server's world, shipped here as
 * Polaris builds (`format.ts`).
 *
 * Polaris's own small builds come first. One from elsewhere is converted
 * offline (`convert.ts`) from a copy the operator provides - the sources Polaris
 * may use need a signed-in download - and added as `builds/<id>.json`,
 * imported and listed below.
 */

import snowman from "./builds/snowman.json";
import giftPile from "./builds/gift-pile.json";
import scarecrow from "./builds/scarecrow.json";
import snowBench from "./builds/snow-bench.json";
import pumpkinPatch from "./builds/pumpkin-patch.json";
import winterSpruce from "./builds/winter-spruce.json";
import witchCauldron from "./builds/witch-cauldron.json";
import graveyardCorner from "./builds/graveyard-corner.json";
import { polarisBuildSchema, type PolarisBuild } from "./format";

export const WORLD_BUILDS: readonly PolarisBuild[] = [
    snowman,
    winterSpruce,
    giftPile,
    snowBench,
    pumpkinPatch,
    graveyardCorner,
    witchCauldron,
    scarecrow
].map((one) => polarisBuildSchema.parse(one));
