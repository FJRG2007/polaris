/**
 * Vault settings (/vault/settings).
 */

import Link from "next/link";
import { VaultSettings } from "./vault-settings";
import { requirePermission } from "@/lib/session";
import { vaultStateAction } from "../vault-actions";
import { Button, Card, CardBody } from "@polaris/ui";

export const dynamic = "force-dynamic";

export default async function VaultSettingsPage() {
    const user = await requirePermission("vault.use");
    const state = await vaultStateAction();

    if (!state.exists || !state.protectedKey) {
        return (
            <div className="mx-auto max-w-2xl">
                <Card>
                    <CardBody className="flex flex-col items-start gap-3 p-6">
                        <p className="text-sm text-muted-foreground">
                            There is no vault to configure yet.
                        </p>
                        <Button asChild size="sm">
                            <Link href="/vault">Set up my vault</Link>
                        </Button>
                    </CardBody>
                </Card>
            </div>
        );
    }

    return (
        <VaultSettings
            email={state.email}
            name={user.name}
            kdf={state.kdf}
            protectedKey={state.protectedKey}
        />
    );
}
