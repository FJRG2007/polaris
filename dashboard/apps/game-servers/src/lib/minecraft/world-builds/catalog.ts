/**
 * The seasonal builds Polaris places in a server's world, converted offline
 * (`convert.ts`) and shipped here as Polaris builds.
 *
 * Empty until a build has been converted: the sources Polaris may use need a
 * signed-in download, so each file is converted from a copy the operator
 * provides and added as `builds/<id>.json`, imported and listed below.
 */

import type { PolarisBuild } from "./format";

export const WORLD_BUILDS: readonly PolarisBuild[] = [];
