/**
 * The actions the deployment's AI providers screen calls, bundled for the
 * shared panel (`components/model-keys/ai-providers-panel.tsx`). Each one
 * establishes an administrator itself; this only says which file each is in.
 */

import * as keys from "./actions";
import * as logins from "./login-actions";
import * as clouds from "./cloud-actions";

export const INSTANCE_ACTIONS = {
    keys: {
        add: keys.addInstanceModelKeyAction,
        update: keys.updateInstanceModelKeyAction,
        remove: keys.deleteInstanceModelKeyAction,
        reorder: keys.reorderInstanceModelKeysAction,
        toggle: keys.toggleInstanceModelKeyAction,
        limit: keys.limitInstanceModelKeyAction,
        revive: keys.reviveInstanceModelKeyAction
    },
    // Plain objects of action references: a module namespace is not something
    // a client component's props can carry.
    logins: {
        startProviderLoginAction: logins.startProviderLoginAction,
        pollProviderLoginAction: logins.pollProviderLoginAction,
        finishGitlabLoginAction: logins.finishGitlabLoginAction,
        goUsageAction: logins.goUsageAction
    },
    clouds: {
        addCloudAccountAction: clouds.addCloudAccountAction,
        startDigitaloceanLoginAction: clouds.startDigitaloceanLoginAction,
        finishDigitaloceanLoginAction: clouds.finishDigitaloceanLoginAction
    }
};
