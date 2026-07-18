/**
 * The app's better-auth instance. Constructed once here (env is guaranteed in a
 * running server) from the shared factory, and re-exported so route handlers,
 * server actions, and the session helpers all share one configuration.
 */

import { createAuth } from "@polaris/auth";

export const auth = createAuth();
