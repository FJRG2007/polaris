import Link from "next/link";
import { Reveal } from "../reveal";
import type { Metadata } from "next";
import { LogIn } from "lucide-react";
import { PUBLIC_PATHS } from "@/lib/legal/service";
import { getTranslations } from "@/lib/i18n/request";
import { Button, Card, CardBody } from "@polaris/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("publicPages");
    // i18n-ignore: the product's name is the page's title
    return { title: "Polaris", description: t("about.metaDescription") };
}

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
export default async function AboutPage() {
    const t = await getTranslations("publicPages");
    return (
        <>
            <Reveal className="flex flex-col gap-5">
                {/* i18n-ignore: the product's name */}
                <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">Polaris</h1>
                <p className="text-lg leading-relaxed text-muted-foreground">{t("about.intro")}</p>
                <p className="text-base leading-relaxed text-muted-foreground">{t("about.account")}</p>
                <div className="pt-1">
                    <Button asChild>
                        <Link href="/oauth/login">
                            <LogIn className="size-4" />
                            {t("layout.signIn")}
                        </Link>
                    </Button>
                </div>
            </Reveal>

            <Reveal className="flex flex-col gap-4">
                <h2 className="text-xl font-medium tracking-tight">{t("about.connecting.title")}</h2>
                <p className="text-base leading-relaxed text-muted-foreground">{t("about.connecting.body")}</p>
                <p className="text-base leading-relaxed text-muted-foreground">
                    {t.rich("about.connecting.owner", {
                        link: (chunks) => (
                            <Link key="link" href={PUBLIC_PATHS.privacy} className="text-primary hover:underline">
                                {chunks}
                            </Link>
                        )
                    })}
                </p>
            </Reveal>

            <Reveal>
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <h2 className="text-xl font-medium tracking-tight">{t("about.software.title")}</h2>
                        <p className="text-base leading-relaxed text-muted-foreground">{t("about.software.body")}</p>
                        <a
                            href="https://github.com/FJRG2007/polaris"
                            target="_blank"
                            rel="noreferrer noopener"
                            className="w-fit text-sm text-primary hover:underline"
                        >
                            {/* i18n-ignore: an address */}
                            github.com/FJRG2007/polaris
                        </a>
                    </CardBody>
                </Card>
            </Reveal>
        </>
    );
}
