import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { RunsOnSnippet } from "../runs-on-snippet";
import { Card, CardBody, CardHeader, CardTitle, PageHeader } from "@polaris/ui";

export const dynamic = "force-dynamic";

/**
 * What this app is and how to use it.
 *
 * Written because the rest of the app assumes an answer to a question it never
 * asks anywhere: what a self-hosted runner is, what changes in a workflow file to
 * use one, and which of the safety choices matter. Every heading here is a
 * question somebody actually has to answer to get a job running, in the order
 * they hit them.
 */
export default async function RunnersGuidePage() {
    await requirePermission("system.manage");

    return (
        <>
            <PageHeader
                title="How it works"
                description="Running GitHub Actions on your own machines: what to set up, what to change in a workflow, and what to be careful with."
            />

            <div className="flex max-w-3xl flex-col gap-4">
                <Step title="1. Connect GitHub, with permission to register runners">
                    <p>
                        Polaris registers a runner on your behalf, which needs more than reading a repository. Under{" "}
                        <Link href="/admin/integrations" className="underline">
                            Integrations
                        </Link>
                        , connect GitHub and give it <strong>Administration: read and write</strong> on the
                        repositories you want runners for, or <strong>Self-hosted runners: read and write</strong> on
                        the organization to cover all of them at once.
                    </p>
                    <p>
                        A GitHub App is the better of the two connections: it can hold the narrow organization
                        permission instead of blanket repository administration, its tokens expire on their own, and it
                        does not belong to one person&apos;s account.
                    </p>
                </Step>

                <Step title="2. Add a pool">
                    <p>
                        A pool is one machine plus the repositories it serves.{" "}
                        <Link href="/apps/runners" className="underline">
                            Add one
                        </Link>{" "}
                        and pick the server, how many jobs it may take at once, and whether jobs run in a container or
                        in a directory on the machine.
                    </p>
                    <p>
                        Prefer the container. A job in a container is thrown away with it; a job in a directory is a
                        clean slate but not a boundary, and it can reach whatever the Polaris login on that machine
                        can.
                    </p>
                </Step>

                <Step title="3. Point a workflow at it">
                    <p>
                        Change one line. Where a workflow says <code>runs-on: ubuntu-latest</code>, it now says the
                        labels your pool registered with:
                    </p>
                    <RunsOnSnippet labels={["self-hosted"]} label="" />
                    <p>
                        The next run queues on GitHub, Polaris notices, starts a runner for that repository, and the
                        job lands on it. Each runner takes a single job and disappears, so nothing is left behind
                        between jobs.
                    </p>
                </Step>

                <Step title="4. Decide what each repository may run">
                    <p>
                        Under{" "}
                        <Link href="/apps/runners/repos" className="underline">
                            Repositories
                        </Link>{" "}
                        every repository a pool serves has its own settings: which events run here (pushes, pull
                        requests, on a schedule, by hand), whether pull requests from forks run at all, and whether
                        its jobs can read your secrets.
                    </p>
                    <p>
                        The check happens on the machine, after GitHub hands the job over and before any step of it
                        runs, so a job that is not allowed never executes anything. It shows up under{" "}
                        <Link href="/apps/runners/runs" className="underline">
                            Runs
                        </Link>{" "}
                        as turned down, with the reason - which is what the person waiting on a red check needs.
                    </p>
                </Step>

                <Step title="5. Give the runners what they need to read">
                    <p>
                        <Link href="/apps/runners/secrets" className="underline">
                            Secrets
                        </Link>{" "}
                        are values your machines carry into a job: a registry login, an endpoint that only exists
                        inside your network, a key you would rather not upload to GitHub. They arrive as environment
                        variables, so a step reads one as <code>$REGISTRY_TOKEN</code>.
                    </p>
                    <p>
                        These are not GitHub&apos;s secrets and do not appear in <code>{"${{ secrets.NAME }}"}</code>
                        &nbsp;- only GitHub can fill that in. A secret can apply to every repository a pool serves or
                        to one of them, and the narrower one wins.
                    </p>
                </Step>

                <Card>
                    <CardHeader>
                        <CardTitle>What to be careful with</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3 text-sm text-muted-foreground">
                        <p>
                            <strong className="text-foreground">Public repositories.</strong> Anybody on GitHub can
                            open a pull request against one, and a pull request can change the workflow that runs. That
                            is why Polaris will not serve a public repository until you say so on that repository, and
                            why GitHub recommends never pointing a self-hosted runner at one.
                        </p>
                        <p>
                            <strong className="text-foreground">Pull requests from forks.</strong> The code in one was
                            written by whoever opened it. They are turned down by default. Turning them on for a
                            repository means strangers&apos; code runs on that machine with whatever the environment
                            holds - which is why the secrets switch sits next to it.
                        </p>
                        <p>
                            <strong className="text-foreground">A container is not a promise about the network.</strong>{" "}
                            A contained job cannot reach the machine&apos;s files, but it can reach whatever that
                            machine can reach on the network. A runner on a box inside your network is inside your
                            network.
                        </p>
                        <p>
                            <strong className="text-foreground">Budgets are per repository.</strong> A pool shared
                            between repositories can be given a minute budget and a daily job limit so one busy
                            repository is not the only one that ever gets served.
                        </p>
                    </CardBody>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>When nothing runs</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-2 text-sm text-muted-foreground">
                        <p>
                            The pool card says what is wrong with the pool - an unreachable machine, a missing
                            permission, a repository over its budget. A job that reached a runner and was turned down
                            says so under Runs, with the rule that turned it down.
                        </p>
                        <p>
                            If the workflow is still queued on GitHub and neither screen says anything, check that its{" "}
                            <code>runs-on</code> labels match the pool&apos;s exactly - GitHub only offers a job to a
                            runner carrying every label the job asked for.
                        </p>
                    </CardBody>
                </Card>
            </div>
        </>
    );
}

function Step({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 text-sm text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs">
                {children}
            </CardBody>
        </Card>
    );
}
