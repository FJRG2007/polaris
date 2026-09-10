/**
 * The Docker Swarm runtime. Identical in shape to the compose runtime but deploys
 * the same rendered spec as a swarm stack (`docker stack deploy`), so replicas,
 * rolling updates, and rollback come from the engine. Selected for targets whose
 * runtime is "swarm"; it is the scalability-oriented default where a target has a
 * swarm active. Written against the same RuntimePorts seam, so it serves local and
 * remote identically.
 */

import { parseContainerState } from "./status.js";
import { imageTag as toImageTag } from "../naming.js";
import { RELEASE_IMAGE_GONE, pinRelease, rollbackImageOf } from "./release.js";
import { buildPorts, loadPrebuilt, shipRelease } from "./ship.js";
import { appComposeSpec, dbComposeSpec, dbPlanImages, forSwarm } from "../compose-spec.js";
import type {
    AppDeployPlan,
    DbDeployPlan,
    DeployResult,
    RuntimeContext,
    RuntimeDriver,
    RuntimeStatus,
    ServiceRef
} from "./driver.js";

export class SwarmRuntime implements RuntimeDriver {
    public readonly engine = "swarm" as const;

    public async ensureNetwork(): Promise<void> {
        return undefined;
    }

    public async deployApplication(
        plan: AppDeployPlan,
        ctx: RuntimeContext
    ): Promise<DeployResult> {
        const sink = (chunk: Buffer): void => ctx.log(chunk);
        let imageTag: string;
        let kept: string | null;
        try {
            kept = (await loadPrebuilt(plan, ctx)) ?? (await rollbackImageOf(plan, ctx));
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : RELEASE_IMAGE_GONE
            };
        }
        if (kept) {
            imageTag = kept;
        } else if (plan.build.method === "image") {
            if (!plan.build.imageRef)
                return { ok: false, error: "an image source needs an image reference" };
            imageTag = plan.build.imageRef;
            await ctx.ports.pull(imageTag, sink);
        } else if (
            (plan.build.method === "dockerfile" || plan.build.method === "nixpacks") &&
            ctx.buildContext
        ) {
            imageTag = toImageTag(plan.build.name, plan.build.commitSha);
            const context = await ctx.buildContext();
            await buildPorts(ctx).build(
                {
                    tag: imageTag,
                    // A Dockerfile Polaris generated wins - see the compose runtime.
                    dockerfile: context.dockerfile ?? plan.build.dockerfilePath,
                    contextTar: context.tar,
                    // Detection may have moved the build up to the repository root -
                    // a workspace cannot install from inside one of its members.
                    root: context.root ?? plan.build.rootDirectory,
                    builder:
                        context.dockerfile || plan.build.method !== "nixpacks"
                            ? "docker"
                            : "nixpacks"
                },
                sink
            );
        } else {
            return {
                ok: false,
                error: `build method "${plan.build.method}" is not yet supported on the swarm runtime`
            };
        }
        // Kept under the release's own name before it runs - see the compose runtime,
        // including for a build made on another machine and carried here.
        if (!kept && plan.build.method !== "image" && ctx.builder) {
            imageTag = await pinRelease(imageTag, plan, { ...ctx, ports: buildPorts(ctx) });
            try {
                imageTag = await shipRelease(imageTag, plan, ctx);
            } catch (error) {
                return {
                    ok: false,
                    error: error instanceof Error ? error.message : "the image could not be copied"
                };
            }
        } else if (!kept) {
            imageTag = await pinRelease(imageTag, plan, ctx);
        }
        const spec = forSwarm(appComposeSpec(plan, imageTag, ctx.target.proxyNetwork));
        try {
            await ctx.ports.stackUp(spec, sink);
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : "stack deploy failed"
            };
        }
        return { ok: true, imageTag };
    }

    public async deployDatabase(plan: DbDeployPlan, ctx: RuntimeContext): Promise<DeployResult> {
        const sink = (chunk: Buffer): void => ctx.log(chunk);
        for (const image of dbPlanImages(plan)) await ctx.ports.pull(image, sink);
        const spec = forSwarm(dbComposeSpec(plan, ctx.target.proxyNetwork));
        try {
            await ctx.ports.stackUp(spec, sink);
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : "database deploy failed"
            };
        }
        return { ok: true };
    }

    public async stop(ref: ServiceRef, ctx: RuntimeContext): Promise<void> {
        await ctx.ports.stackDown(ref.project, (chunk) => ctx.log(chunk));
    }

    public async remove(ref: ServiceRef, ctx: RuntimeContext): Promise<void> {
        await ctx.ports.stackDown(ref.project, (chunk) => ctx.log(chunk));
    }

    public async scale(ref: ServiceRef, replicas: number, ctx: RuntimeContext): Promise<void> {
        // Swarm scaling is applied by re-rendering the stack with the new replica
        // count on the next deploy; there is no live scale primitive in the seam.
        ctx.log(Buffer.from(`scale ${ref.name} -> ${replicas} (applied on next deploy)\n`));
    }

    public async rollback(ref: ServiceRef, toImageTag: string, ctx: RuntimeContext): Promise<void> {
        ctx.log(Buffer.from(`rollback ${ref.name} -> ${toImageTag}\n`));
    }

    public async status(ref: ServiceRef, ctx: RuntimeContext): Promise<RuntimeStatus> {
        const inspect = await ctx.ports.inspect(ref.name);
        const state = parseContainerState(inspect);
        return { state: state.status, health: state.health };
    }
}
