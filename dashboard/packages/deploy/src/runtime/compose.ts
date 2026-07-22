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
        } else if ((plan.build.method === "dockerfile" || plan.build.method === "nixpacks") && ctx.buildContext) {
            // Build from the cloned repo: a Dockerfile, or Nixpacks auto-detecting the
            // framework (no Dockerfile needed). Then run the built image.
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
            // buildpacks/static need a builder toolchain on the target; not yet wired.
            return { ok: false, error: `build method "${plan.build.method}" is not yet supported on the compose runtime` };
        }

        const effectivePlan = await this.refineContainerPort(plan, imageTag, ctx);
        const spec = appComposeSpec(effectivePlan, imageTag, ctx.target.proxyNetwork);
        // Establish any NAS mounts the volumes bind onto, before the container comes
        // up - so `<mount_root>/<id>/...` resolves onto the NAS, not an empty dir.
        try {
            for (const mount of plan.mounts ?? []) {
                ctx.log(Buffer.from(`Mounting ${mount.kind.toUpperCase()} ${mount.source}...\n`));
                await ctx.ports.ensureMount(mount);
            }
        } catch (error) {
            return { ok: false, error: `could not mount a NAS volume: ${error instanceof Error ? error.message : "mount failed"}` };
        }
        try {
            await ctx.ports.composeUp(spec, sink);
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "compose up failed" };
        }
        return { ok: true, imageTag };
    }

    /**
     * When the user has not pinned a container port, refine the fallback guess from
     * the image's own declared exposed port (now that the image is present). If the
     * image exposes exactly one TCP port, publish to that - so `IP:port` reaches a
     * live socket instead of a dead one (the classic "deployed but not reachable"
     * cause: an image on 5601 mapped to 80). If it exposes several or none, keep the
     * guess and note it in the log, since we cannot know which the app serves on.
     */
    private async refineContainerPort(
        plan: AppDeployPlan,
        imageTag: string,
        ctx: RuntimeContext
    ): Promise<AppDeployPlan> {
        if (!plan.autoContainerPort || !plan.expose) return plan;
        let exposed: number[];
        try {
            exposed = await ctx.ports.inspectImage(imageTag);
        } catch {
            return plan;
        }
        if (exposed.length === 0) return plan;
        if (exposed.length > 1) {
            ctx.log(
                Buffer.from(
                    `Image exposes multiple ports (${exposed.join(", ")}); publishing container port ${plan.expose.container}. ` +
                        "Set the container port explicitly if the app serves on a different one.\n"
                )
            );
            return plan;
        }
        const detected = exposed[0];
        if (detected === undefined || detected === plan.expose.container) return plan;
        ctx.log(Buffer.from(`Detected container port ${detected} from the image (was ${plan.expose.container}).\n`));
        return { ...plan, expose: { ...plan.expose, container: detected } };
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
