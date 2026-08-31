"use client";

/**
 * The one thing the keys table cannot do: run the login for somebody.
 *
 * Everything else about an agent account is a key - it is named, reordered,
 * renamed, given an end date and shown with its last use - so it is listed in
 * the same table the provider keys are listed in, and this is not a second copy
 * of that. It is the button beside it.
 *
 * Only the credentials with a login to walk through appear here. An API key is
 * copied off a page and belongs entirely to the table's own Add dialog; opening
 * a container to produce one would be a machine started for nothing.
 *
 * enigma:allow-no-reset - nothing on this card is a password field. The login
 * happens in the terminal the dialog opens, and the person is already signed in
 * to Polaris to be looking at it.
 */

import { useState } from "react";
import { Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { AgentLogo } from "@/components/logos";
import { Button, Card, CardBody } from "@polaris/ui";
import type { AgentSignin } from "@/lib/agents/agent-signins";
import { SigninDialog, type SigninDialogActions } from "./signin-dialog";

export function AssistedSigninCard({
    signins,
    actions
}: {
    signins: AgentSignin[];
    actions: Omit<SigninDialogActions, "save"> & {
        save: (input: unknown) => Promise<{ error?: string }>;
    };
}) {
    const [signingIn, setSigningIn] = useState<AgentSignin | null>(null);
    const router = useRouter();

    if (signins.length === 0) return null;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">Sign in without leaving here</h2>
                    <p className="text-muted-foreground text-xs">
                        Polaris runs the vendor&apos;s own login on a machine of its own and adds what it produces to
                        the list above. You authorise it in your browser; nothing else is asked of you.
                    </p>
                </div>

                <div className="flex flex-wrap gap-2">
                    {signins.map((signin) => (
                        <Button key={signin.slug} size="sm" variant="outline" onClick={() => setSigningIn(signin)}>
                            <AgentLogo
                                id={signin.serves[0]?.id ?? "custom"}
                                label={signin.serves[0]?.label ?? signin.label}
                                className="size-4 shrink-0"
                            />
                            <Wand2 className="size-4 shrink-0" />
                            {signin.serves[0]?.label ?? signin.label}
                        </Button>
                    ))}
                </div>
            </CardBody>

            {signingIn ? (
                <SigninDialog
                    signin={signingIn}
                    actions={{
                        ...actions,
                        // Stored through the same write the table's own dialog
                        // uses, so a credential that arrived by either route is
                        // checked and named exactly the same way.
                        save: (value: string, identity, name: string) =>
                            actions.save({
                                provider: signingIn.slug,
                                name,
                                secret: value,
                                identity,
                                expiresAt: null
                            })
                    }}
                    onClose={() => setSigningIn(null)}
                    onDone={() => {
                        setSigningIn(null);
                        router.refresh();
                    }}
                />
            ) : null}
        </Card>
    );
}
