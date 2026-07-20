/**
 * The builder registry: normalize a BuildInput into a BuildSpec, and turn a spec
 * into the argv that produces the image. One dispatcher keeps adding a build type
 * to a single place, and both functions stay pure and unit-testable with Docker
 * off. The runtime feeds `buildCommand` output to the host daemon (argv) or the
 * SSH path (quoted into bash).
 */

import { imageTag as toImageTag } from "../naming.js";
import {
    DEFAULT_BUILDPACKS_BUILDER,
    DEFAULT_DOCKERFILE,
    type BuildInput,
    type BuildSpec
} from "./types.js";

export * from "./types.js";

/** Normalize source settings into a resolved BuildSpec (assigns the image tag). */
export function buildSpec(input: BuildInput): BuildSpec {
    const buildArgs = input.buildArgs ?? {};
    const tag =
        input.method === "image" || input.method === "compose"
            ? ""
            : toImageTag(input.name, input.commitSha);
    return {
        method: input.method,
        imageTag: tag,
        imageRef: input.imageRef,
        contextPath: input.contextPath,
        dockerfilePath: input.dockerfilePath ?? (input.method === "dockerfile" ? DEFAULT_DOCKERFILE : undefined),
        targetStage: input.targetStage,
        buildArgs,
        builder: input.method === "buildpacks" ? input.builder ?? DEFAULT_BUILDPACKS_BUILDER : undefined,
        staticDir: input.staticDir,
        composeYaml: input.composeYaml
    };
}

/** argv that builds (or pulls) the image for a spec. Empty for compose, whose
 *  `up --build` builds inline. */
export function buildCommand(spec: BuildSpec): string[] {
    switch (spec.method) {
        case "image":
            return spec.imageRef ? ["docker", "pull", spec.imageRef] : [];
        case "compose":
            return [];
        case "dockerfile":
            return dockerBuild(spec.imageTag, spec.contextPath, spec.dockerfilePath, spec.targetStage, spec.buildArgs);
        case "static":
            // The runtime writes a tiny nginx Dockerfile into the context first;
            // the build itself is an ordinary docker build of that context.
            return dockerBuild(spec.imageTag, spec.contextPath, DEFAULT_DOCKERFILE, undefined, spec.buildArgs);
        case "nixpacks":
            return ["nixpacks", "build", spec.contextPath, "--name", spec.imageTag, ...envArgs("--env", spec.buildArgs)];
        case "buildpacks":
            return [
                "pack",
                "build",
                spec.imageTag,
                "--path",
                spec.contextPath,
                "--builder",
                spec.builder ?? DEFAULT_BUILDPACKS_BUILDER,
                ...envArgs("--env", spec.buildArgs)
            ];
    }
}

function dockerBuild(
    tag: string,
    contextPath: string,
    dockerfile: string | undefined,
    targetStage: string | undefined,
    buildArgs: Readonly<Record<string, string>>
): string[] {
    const argv = ["docker", "build", "-t", tag];
    if (dockerfile) argv.push("-f", dockerfile);
    if (targetStage) argv.push("--target", targetStage);
    for (const [key, value] of Object.entries(buildArgs)) argv.push("--build-arg", `${key}=${value}`);
    argv.push(contextPath);
    return argv;
}

/** Expand a key/value map into repeated `<flag> KEY=VALUE` argv pairs. */
function envArgs(flag: string, vars: Readonly<Record<string, string>>): string[] {
    return Object.entries(vars).flatMap(([key, value]) => [flag, `${key}=${value}`]);
}
