/**
 * Environment that has to be in force wherever dependencies are installed,
 * whichever builder is doing the installing.
 *
 * These are not preferences. Each one turns off a check that is meant for the
 * machine a dependency is *chosen* on and that, left on inside a build, decides
 * whether a deployment happens at all - on grounds that have nothing to do with
 * the code being deployed.
 */

/**
 * pnpm refuses to install any package published within the last day. It is on by
 * default: nothing has to be configured, `pnpm config get minimumReleaseAge`
 * reports nothing, and the refusal is `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.
 *
 * On a workstation that is a good guard - it is the window in which a compromised
 * release gets caught and pulled, and there you are deciding whether to adopt a
 * version. In a build it guards nothing. The lockfile has already been written,
 * reviewed and committed with an integrity hash per package, the install resolves
 * nothing, and waiting a day does not make a bad entry good - it only means the
 * same commit that failed this morning deploys tonight. A build that succeeds or
 * fails by the clock is not a safety property.
 *
 * The practical effect of leaving it on: any project on pnpm that updated a
 * dependency today cannot be deployed until tomorrow.
 */
/**
 * pnpm blocks dependency install scripts and then exits non-zero for having
 * blocked them - `ERR_PNPM_IGNORED_BUILDS`, pointing at an `approve-builds`
 * command that wants a human at a prompt. Approving them in the project does not
 * help either: the `pnpm.onlyBuiltDependencies` field in package.json is no longer
 * read, so a project that already made this decision has it silently dropped and
 * fails anyway.
 *
 * Installing a build toolchain is the moment those scripts are meant to run - it
 * is how a native dependency gets its binary. And the step immediately after this
 * one runs the project's own build, which executes that same dependency tree as
 * code. Refusing a postinstall and then handing the whole of node_modules the
 * process a second later is not a boundary; the boundary is the build container.
 */
export const INSTALL_ENV: Readonly<Record<string, string>> = {
    PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0",
    PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "true"
};
