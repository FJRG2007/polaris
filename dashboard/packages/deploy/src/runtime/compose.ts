/**
 * The plain-Docker (compose) runtime. It drives a deploy through the RuntimePorts
 * seam, so the same code path runs on the local host (ports backed by the host
 * daemon) and on a remote server (ports backed by SSH). Scaling is delegated to
 * Traefik load-balancing across replicas; a rolling, health-gated replace is a
 * refinement tracked on top of this straight up/down flow.
 */

import type { OutputSink } from "../ports.js";
import { parseContainerState } from "./status.js";
import { imageTag as toImageTag } from "../naming.js";
import type { ComposeSpec } from "../compose-spec.js";
import { mountFailureReason } from "../mount-failure.js";
import { appComposeSpec, dbComposeSpec } from "../compose-spec.js";
import { deployFailureReason, isOutOfSpace, isStaleImageLease } from "../deploy-failure.js";
import type {
    AppDeployPlan,
    DbDeployPlan,
    DeployResult,
    RuntimeContext,
    RuntimeDriver,
    RuntimeStatus,
    ServiceRef
} from "./driver.js";

/**
 * Announce a step and time it. `step("Doing the thing")` writes the line, and
 * the returned function closes it with how long it took (plus an optional word
 * on what happened), so every phase of a deploy accounts for its own seconds.
 */
function timer(ctx: RuntimeContext): (label: string) => (note?: string) => void {
    return (label) => {
        const startedAt = Date.now();
        ctx.log(Buffer.from(`==> ${label}...\n`));
        return (note) => {
            const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
            ctx.log(Buffer.from(`==> ${label}: ${note ? `${note}, ` : ""}${seconds}s\n`));
        };
    };
}

/**
 * Give up, and say why in the log.
 *
 * Every way this pipeline can fail used to end the same way: the reason was
 * returned, the deployment was marked failed, and the log simply stopped -
 * usually mid-step, because a step that throws never writes its closing line.
 * What the operator was left with was a build that looked like it worked and a
 * red badge with nothing to read, which sends them to the wrong place entirely.
 *
 * The reason belongs in the log because the log is what they already have open.
 * It is still returned as well: that is what the deployment record stores.
 */
function fail(ctx: RuntimeContext, error: string): DeployResult {
    ctx.log(Buffer.from(`==> Failed: ${error}
`));
    return { ok: false, error };
}

/** The sentence inside an unknown thrown value, or a stated fallback. */
function reasonOf(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Bring the containers up, and do it twice when the image store lost the image.
 *
 * Seen in the wild: the pull finishes ("Downloaded newer image for ...:latest"),
 * the very next step asks for the same image, and the daemon answers "unable to
 * lease content: lease does not exist". The content was fetched and the claim on
 * it is gone - typically because something reclaimed disk while the pull was in
 * flight - so the deploy stops on a sentence about leases with an image that had
 * just arrived.
 *
 * Nothing about the app, the registry or the target is wrong, and the operator's
 * only move would be to press deploy again. So it is pressed here: the image is
 * fetched once more and the same spec goes up. Only for this one failure, only
 * once, and only when there is an image to re-fetch - a locally built one has
 * nowhere to be fetched from, and repeating anything else would just fail twice.
 */
async function composeUpRetryingLease(
    ctx: RuntimeContext,
    spec: ComposeSpec,
    sink: OutputSink,
    pullable: string | null
): Promise<void> {
    try {
        await ctx.ports.composeUp(spec, sink);
    } catch (error) {
        const said = reasonOf(error, "");
        if (!pullable || !isStaleImageLease(said)) throw error;
        ctx.log(
            Buffer.from(
                `The image store lost the image it had just fetched; fetching ${pullable} again and starting once more.\n`
            )
        );
        await ctx.ports.pull(pullable, sink);
        await ctx.ports.composeUp(spec, sink);
    }
}

/**
 * Pull, and if the machine had no room for it, make some and pull once more.
 *
 * The one moment where handing back build cache is unambiguously right whatever
 * the disk says: something has already failed, and every byte of cache on that
 * machine is worth less than the deploy that cannot land. What is freed comes
 * back on the next build or pull; volumes are never in it.
 *
 * Only once, and only when the machine actually gave something back. A retry
 * that frees nothing would fail identically, and a loop that keeps pulling at a
 * disk with no room is a deploy that never ends and a log nobody can read.
 */
async function pullWithRoom(image: string, ctx: RuntimeContext, sink: OutputSink): Promise<void> {
    try {
        await ctx.ports.pull(image, sink);
        return;
    } catch (error) {
        const said = reasonOf(error, "");
        if (!isOutOfSpace(said) || !ctx.ports.reclaimSpace) throw error;

        const freed = await ctx.ports.reclaimSpace().catch(() => 0);
        if (freed <= 0) throw error;
        ctx.log(
            Buffer.from(
                `The machine had no room for that image. Freed ${Math.round(freed / 1_000_000)} MB of build cache and unused layers - no volume was touched - and fetching it again.\n`
            )
        );
        await ctx.ports.pull(image, sink);
    }
}

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
        // The pipeline's own steps are timed and announced. Without this the log is
        // whatever docker happened to print, so a deploy that spends a minute
        // fetching the source and a second building it reads as a slow build - and
        // a step with no output of its own (mounting a share) looks like a hang.
        const step = timer(ctx);
        let imageTag: string;
        if (plan.build.method === "image") {
            if (!plan.build.imageRef) return fail(ctx, "an image source needs an image reference");
            imageTag = plan.build.imageRef;
            const done = step(`Pulling ${plan.build.imageRef}`);
            try {
                await pullWithRoom(imageTag, ctx, sink);
            } catch (error) {
                // Translated on the way out, for the reason deploy-failure.ts
                // gives: the image store reports a disk with no room left as a
                // failed rename inside its own content directory, which reads
                // like a corrupt image and sends people to the registry.
                return fail(
                    ctx,
                    deployFailureReason(reasonOf(error, ""), `could not pull ${plan.build.imageRef}`)
                );
            }
            done();
        } else if ((plan.build.method === "dockerfile" || plan.build.method === "nixpacks") && ctx.buildContext) {
            // Build from the cloned repo: a Dockerfile, or Nixpacks auto-detecting the
            // framework (no Dockerfile needed). Then run the built image.
            imageTag = toImageTag(plan.build.name, plan.build.commitSha);
            const fetched = step("Fetching the source");
            const context = await ctx.buildContext();
            fetched();
            const built = step("Building the image");
            try {
                await ctx.ports.build(
                    {
                        tag: imageTag,
                        // A Dockerfile Polaris generated wins: it exists precisely
                        // because the project was recognized, and it pins the runtime
                        // the project asked for rather than whatever the build machine
                        // happens to carry.
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
            } catch (error) {
                // A build fills the same disk a pull does, and reports it the
                // same unhelpful way.
                return fail(ctx, deployFailureReason(reasonOf(error, ""), "the image would not build"));
            }
            built();
        } else {
            // buildpacks/static need a builder toolchain on the target; not yet wired.
            return fail(ctx, `build method "${plan.build.method}" is not yet supported on the compose runtime`);
        }

        const effectivePlan = await this.refineContainerPort(plan, imageTag, ctx);
        const spec = appComposeSpec(effectivePlan, imageTag, ctx.target.proxyNetwork);
        // Establish any NAS mounts the volumes bind onto, before the container comes
        // up - so `<mount_root>/<id>/...` resolves onto the NAS, not an empty dir.
        // Which share was being mounted when it went wrong. A deploy can bind
        // more than one, and "a NAS volume could not be mounted" names none of
        // them.
        let mounting: { source: string } | null = null;
        try {
            for (const mount of plan.mounts ?? []) {
                mounting = mount;
                const done = step(`Mounting ${mount.kind.toUpperCase()} ${mount.source}`);
                const created = await ctx.ports.ensureMount(mount);
                done(created ? "mounted" : "already mounted");
            }
        } catch (error) {
            // The share is what the app's data lives on, so a container brought
            // up without it would write into an empty directory on the host and
            // look fine until somebody went looking for the files.
            //
            // Translated on the way out, because the mount helper's own words
            // send people to the wrong place: "Server abruptly closed the
            // connection" is what a machine that is switched off produces, and
            // it reads like a password problem.
            const share = mounting?.source ?? "the share";
            return fail(ctx, mountFailureReason(share, reasonOf(error, "")));
        }
        const started = step("Starting the containers");
        try {
            await composeUpRetryingLease(ctx, spec, sink, plan.build.method === "image" ? imageTag : null);
        } catch (error) {
            return fail(ctx, deployFailureReason(reasonOf(error, ""), "compose up failed"));
        }
        started();
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
                    `Image exposes multiple ports (${exposed.join(", ")}); publishing container port ${plan.expose.container}. Set the container port explicitly if the app serves on a different one.\n`
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
            await composeUpRetryingLease(ctx, spec, sink, plan.image);
        } catch (error) {
            return fail(ctx, deployFailureReason(reasonOf(error, ""), "database deploy failed"));
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
