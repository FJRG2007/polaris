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
        rootDirectory: normalizeRoot(input.rootDirectory),
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
            return [
                "nixpacks",
                "build",
                joinRoot(spec.contextPath, spec.rootDirectory),
                "--name",
                spec.imageTag,
                ...envArgs("--env", spec.buildArgs)
            ];
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

/**
 * A root directory as the rest of the build model expects it: forward slashes, no
 * leading or trailing separator, and never a path that climbs out of the context.
 *
 * Normalized here rather than trusted from the stored source config, because this one
 * value reaches a shell argument on the target and a header the host daemon reads.
 * Empty (the repository root) for anything that does not survive the rules.
 */
export function normalizeRoot(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const cleaned = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!cleaned || cleaned === ".") return undefined;
    if (cleaned.split("/").some((segment) => segment === "..")) return undefined;
    return cleaned;
}

/**
 * The Dockerfile path to build with, relative to the context (the repository root),
 * given the application's root directory.
 *
 * A path is stated the way it would be inside the root directory, so a service rooted
 * at `apps/web` that says `Dockerfile` builds `apps/web/Dockerfile` - which is what
 * somebody setting a root directory means, and what makes the field worth having for a
 * Dockerfile build at all.
 *
 * A path that already carries the root is left alone rather than nested inside itself:
 * services configured before there was a root directory have the full path stored, and
 * setting the root on one of those must not break it.
 */
export function resolveDockerfilePath(
    root: string | undefined,
    dockerfilePath: string | undefined
): string | undefined {
    const normalized = normalizeRoot(root);
    const file = dockerfilePath?.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) return file || undefined;
    if (file && (file === normalized || file.startsWith(`${normalized}/`))) return file;
    return `${normalized}/${file || DEFAULT_DOCKERFILE}`;
}

/** The context path with a root directory appended, for a builder that takes one
 *  directory rather than a context plus a path inside it. */
function joinRoot(contextPath: string, root: string | undefined): string {
    return root ? `${contextPath.replace(/\/+$/, "")}/${root}` : contextPath;
}

/** Expand a key/value map into repeated `<flag> KEY=VALUE` argv pairs. */
function envArgs(flag: string, vars: Readonly<Record<string, string>>): string[] {
    return Object.entries(vars).flatMap(([key, value]) => [flag, `${key}=${value}`]);
}
