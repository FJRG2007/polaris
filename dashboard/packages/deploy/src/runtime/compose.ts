/**
 * The plain-Docker (compose) runtime. It drives a deploy through the RuntimePorts
 * seam, so the same code path runs on the local host (ports backed by the host
 * daemon) and on a remote server (ports backed by SSH). Scaling is delegated to
 * Traefik load-balancing across replicas; a rolling, health-gated replace is a
 * refinement tracked on top of this straight up/down flow.
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

export class ComposeRuntime implements RuntimeDriver {
    public readonly engine = "compose" as const;

    // Compose attaches services to the shared proxy network as an external
    // network; it is created once when the target is set up (onboarding / the
    // dashboard stack), so there is nothing to do here per deploy.
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
        } else if (plan.build.method === "dockerfile" && ctx.buildContext) {
            // Build from a Dockerfile in the cloned repo, then run the built image.
            imageTag = toImageTag(plan.build.name, plan.build.commitSha);
            const contextTar = await ctx.buildContext();
            await ctx.ports.build(
                { tag: imageTag, dockerfile: plan.build.dockerfilePath, contextTar },
                sink
            );
        } else {
            // nixpacks/buildpacks/static need a builder toolchain on the target; not
            // yet wired. Fail clearly rather than silently.
            return { ok: false, error: `build method "${plan.build.method}" is not yet supported on the compose runtime` };
        }

        const spec = appComposeSpec(plan, imageTag, ctx.target.proxyNetwork);
        try {
            await ctx.ports.composeUp(spec, sink);
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "compose up failed" };
        }
        return { ok: true, imageTag };
    }

    public async deployDatabase(plan: DbDeployPlan, ctx: RuntimeContext): Promise<DeployResult> {
        const sink = (chunk: Buffer): void => ctx.log(chunk);
        await ctx.ports.pull(plan.image, sink);
        const spec = dbComposeSpec(plan, ctx.target.proxyNetwork);
        try {
            await ctx.ports.composeUp(spec, sink);
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "database deploy failed" };
        }
        return { ok: true };
    }

    public async stop(ref: ServiceRef, ctx: RuntimeContext): Promise<void> {
        await ctx.ports.composeDown(ref.project, (chunk) => ctx.log(chunk));
    }

    public async remove(ref: ServiceRef, ctx: RuntimeContext): Promise<void> {
        await ctx.ports.composeDown(ref.project, (chunk) => ctx.log(chunk));
    }

    public async scale(): Promise<void> {
        // Replica scaling for plain compose is applied by re-rendering the spec
        // with N replicas on the next deploy; there is no live scale primitive in
        // the ports seam. Intentionally a no-op here.
        return undefined;
    }

    public async rollback(ref: ServiceRef, toImageTag: string, ctx: RuntimeContext): Promise<void> {
        // A rollback re-deploys a prior image tag; the pipeline supplies the full
        // plan for that tag and calls deployApplication again, so this hook only
        // records intent.
        ctx.log(Buffer.from(`rollback ${ref.name} -> ${toImageTag}\n`));
    }

    public async status(ref: ServiceRef, ctx: RuntimeContext): Promise<RuntimeStatus> {
        const inspect = await ctx.ports.inspect(ref.name);
        const state = parseContainerState(inspect);
        return { state: state.status, health: state.health };
    }
}
