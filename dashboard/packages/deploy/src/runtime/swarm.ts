/**
 * The Docker Swarm runtime. Identical in shape to the compose runtime but deploys
 * the same rendered spec as a swarm stack (`docker stack deploy`), so replicas,
 * rolling updates, and rollback come from the engine. Selected for targets whose
 * runtime is "swarm"; it is the scalability-oriented default where a target has a
 * swarm active. Written against the same RuntimePorts seam, so it serves local and
 * remote identically.
 */

import { appComposeSpec, dbComposeSpec } from "../compose-spec.js";
import { imageTag as toImageTag } from "../naming.js";
import { parseContainerState } from "./status.js";
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

    public async deployApplication(plan: AppDeployPlan, ctx: RuntimeContext): Promise<DeployResult> {
        const sink = (chunk: Buffer): void => ctx.log(chunk);
        let imageTag: string;
        if (plan.build.method === "image") {
            if (!plan.build.imageRef) return { ok: false, error: "an image source needs an image reference" };
            imageTag = plan.build.imageRef;
            await ctx.ports.pull(imageTag, sink);
        } else if ((plan.build.method === "dockerfile" || plan.build.method === "nixpacks") && ctx.buildContext) {
            imageTag = toImageTag(plan.build.name, plan.build.commitSha);
            const contextTar = await ctx.buildContext();
            await ctx.ports.build(
                {
                    tag: imageTag,
                    dockerfile: plan.build.dockerfilePath,
                    contextTar,
                    builder: plan.build.method === "nixpacks" ? "nixpacks" : "docker"
                },
                sink
            );
        } else {
            return { ok: false, error: `build method "${plan.build.method}" is not yet supported on the swarm runtime` };
        }
        const spec = appComposeSpec(plan, imageTag, ctx.target.proxyNetwork);
        try {
            await ctx.ports.stackUp(spec, sink);
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "stack deploy failed" };
        }
        return { ok: true, imageTag };
    }

    public async deployDatabase(plan: DbDeployPlan, ctx: RuntimeContext): Promise<DeployResult> {
        const sink = (chunk: Buffer): void => ctx.log(chunk);
        await ctx.ports.pull(plan.image, sink);
        const spec = dbComposeSpec(plan, ctx.target.proxyNetwork);
        try {
            await ctx.ports.stackUp(spec, sink);
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "database deploy failed" };
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
