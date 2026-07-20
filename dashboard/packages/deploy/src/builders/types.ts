/**
 * Build model. A builder is a pure function that turns an application's source
 * settings into a normalized BuildSpec; a separate pure generator turns a spec
 * into the argv the runtime runs (locally through the host daemon's validated
 * build endpoint, or remotely as a bash command). No side effects, no I/O.
 */

export type BuildMethod = "image" | "dockerfile" | "nixpacks" | "buildpacks" | "static" | "compose";

/** Raw source settings for one application (decoded from Application.sourceConfig). */
export interface BuildInput {
    readonly method: BuildMethod;
    readonly name: string;
    readonly commitSha?: string;
    /** Directory the build runs in on the target (clone dir or context root). */
    readonly contextPath: string;
    /** method "image": the image reference to pull and run. */
    readonly imageRef?: string;
    /** method "dockerfile": path relative to the context (default "Dockerfile"). */
    readonly dockerfilePath?: string;
    /** method "dockerfile": multi-stage target. */
    readonly targetStage?: string;
    readonly buildArgs?: Readonly<Record<string, string>>;
    /** method "buildpacks": builder image (default paketo jammy base). */
    readonly builder?: string;
    /** method "static": directory of static output to serve. */
    readonly staticDir?: string;
    /** method "compose": the compose file contents. */
    readonly composeYaml?: string;
}

/** Normalized build description with the resolved image tag. */
export interface BuildSpec {
    readonly method: BuildMethod;
    /** "" for image (pulls imageRef) and compose (compose builds inline). */
    readonly imageTag: string;
    readonly imageRef?: string;
    readonly contextPath: string;
    readonly dockerfilePath?: string;
    readonly targetStage?: string;
    readonly buildArgs: Readonly<Record<string, string>>;
    readonly builder?: string;
    readonly staticDir?: string;
    readonly composeYaml?: string;
}

export const DEFAULT_BUILDPACKS_BUILDER = "paketobuildpacks/builder-jammy-base";
export const DEFAULT_DOCKERFILE = "Dockerfile";
