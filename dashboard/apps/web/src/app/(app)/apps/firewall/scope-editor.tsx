/**
 * The rules for one scope, in the order Cloudflare puts them: what the scope covers,
 * then the managed packs, then the address lists, then the operator's own rules.
 *
 * A thin frame around the editor rather than a component of its own - it exists so
 * the page reads as "pick a scope, then here are its rules" and so the chrome around
 * the editor lives somewhere other than inside it.
 */

import { WafEditor } from "./waf-editor";
import { Card, CardBody } from "@polaris/ui";
import type { WafScopeType } from "@polaris/core";

export function FirewallScopeEditor({
    scopeType,
    scopeId,
    description,
    offerLogin,
    callerIp
}: {
    scopeType: WafScopeType;
    scopeId: string;
    description: string;
    offerLogin: boolean;
    callerIp: string | null;
}) {
    return (
        <Card>
            <CardBody>
                <WafEditor
                    scopeType={scopeType}
                    scopeId={scopeId}
                    description={description}
                    offerLogin={offerLogin}
                    callerIp={callerIp}
                />
            </CardBody>
        </Card>
    );
}
