/**
 * Where the built `polaris-agent` bundle is (`scripts/build-native-agent.mjs`),
 * and how a session gets it: the boot downloads it from this instance
 * (`/api/agents/native/bundle`) and checks its digest before running it.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

export const NATIVE_BUNDLE_FILE = "polaris-agent.mjs";

/** The bundle's route on this instance. */
export const NATIVE_BUNDLE_ROUTE = "/api/agents/native/bundle";

/** Where the build put it: beside the app in development, and under the app's
 *  own folder in the standalone tree, which runs from the workspace root. */
export function nativeBundleDir(cwd: string = process.cwd()): string | null {
    const candidates = [join(cwd, "native-agent"), join(cwd, "apps", "web", "native-agent")];
    return candidates.find((dir) => existsSync(join(dir, NATIVE_BUNDLE_FILE))) ?? null;
}
