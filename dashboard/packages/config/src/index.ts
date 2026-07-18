/**
 * @polaris/config - the single source of truth for "what is unlocked".
 *
 * The dashboard ships as one image but runs in two editions. Rather than branch
 * on an environment variable (which the container could not actually back up),
 * the edition is derived from whether the privileged host daemon answers. This
 * package owns the environment schema and the capability model; the live probe
 * that flips the edition to "full" lives in @polaris/hostd-client and feeds the
 * result back here through refreshCapabilities().
 */

export * from "./env.js";
export * from "./capabilities.js";
