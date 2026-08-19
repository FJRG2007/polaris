import Link from "next/link";
import { Reveal } from "../reveal";
import type { Metadata } from "next";
import { LogIn } from "lucide-react";
import { PUBLIC_PATHS } from "@/lib/legal/service";
import { Button, Card, CardBody } from "@polaris/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Polaris",
    description: "Polaris is a self-hosted control plane for files, tasks, deployments and game servers."
};

/**
 * The public front door, and the page a review desk is asking for when it wants
 * an "application home page".
 *
 * Google fails verification on three things a dashboard behind a login always
 * fails: the home page cannot be reached signed out, it does not say what the
 * app is for, and its name does not match the one on the consent screen. So this
 * page exists to answer exactly those, and the product name is written as
 * "Polaris" throughout because that is the name the consent screen has to carry.
 *
 * It says nothing about this particular deployment - not which services it has
 * connected, not who is on it. What a reviewer needs is what the app does with
 * an account somebody connects, and that is the same everywhere.
 */
export default function AboutPage() {
    return (
        <>
            <Reveal className="flex flex-col gap-5">
                <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">Polaris</h1>
                <p className="text-lg leading-relaxed text-muted-foreground">
                    A self-hosted control plane. One place to keep files, run tasks, deploy applications and manage game
                    servers, on hardware its operator owns rather than on somebody else&apos;s service. This is one such
                    deployment, run by the person or organization that installed it.
                </p>
                <p className="text-base leading-relaxed text-muted-foreground">
                    Everything past this page needs an account here, which its operator hands out. There is nothing to
                    sign up for.
                </p>
                <div className="pt-1">
                    <Button asChild>
                        <Link href="/oauth/login">
                            <LogIn className="size-4" />
                            Sign in
                        </Link>
                    </Button>
                </div>
            </Reveal>

            <Reveal className="flex flex-col gap-4">
                <h2 className="text-xl font-medium tracking-tight">Connecting an account</h2>
                <p className="text-base leading-relaxed text-muted-foreground">
                    People with an account here can connect outside accounts of their own, and each connection asks for
                    the least it can. A connected Google account is read-only, and only so the calendar can be shown
                    beside the tasks - Polaris cannot change or delete anything in it. Microsoft and Dropbox are limited
                    to the folder Polaris creates for backups. Steam, Epic Games and Minecraft hand over an account id
                    and a display name, so a game server can tell one player from another, and no credential at all.
                </p>
                <p className="text-base leading-relaxed text-muted-foreground">
                    Connecting is always started by the account&apos;s owner, and unlinking it here destroys the
                    credential and the access with it. The{" "}
                    <Link href={PUBLIC_PATHS.privacy} className="text-primary hover:underline">
                        privacy policy
                    </Link>{" "}
                    sets out what is stored and for how long.
                </p>
            </Reveal>

            <Reveal>
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <h2 className="text-xl font-medium tracking-tight">The software</h2>
                        <p className="text-base leading-relaxed text-muted-foreground">
                            Polaris is open source, published under the Apache 2.0 license. The people who write it
                            operate no service and never see this deployment: it runs entirely on its operator&apos;s
                            own machine.
                        </p>
                        <a
                            href="https://github.com/FJRG2007/polaris"
                            target="_blank"
                            rel="noreferrer noopener"
                            className="w-fit text-sm text-primary hover:underline"
                        >
                            github.com/FJRG2007/polaris
                        </a>
                    </CardBody>
                </Card>
            </Reveal>
        </>
    );
}
