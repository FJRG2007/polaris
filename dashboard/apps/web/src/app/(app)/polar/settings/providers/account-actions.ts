/**
 * The actions an account's AI providers screen calls, bundled for the shared
 * panel (`components/model-keys/ai-providers-panel.tsx`). Each one checks the
 * signed-in person itself; this only says which file each comes from.
 */

import * as keys from "./actions";
import * as logins from "./login-actions";
import * as clouds from "./cloud-actions";

export const ACCOUNT_ACTIONS = {
    keys: {
        add: keys.addModelKeyAction,
        update: keys.updateModelKeyAction,
        remove: keys.deleteModelKeyAction,
        removeMany: keys.deleteModelKeysAction,
        reorder: keys.reorderModelKeysAction,
        toggle: keys.toggleModelKeyAction,
        toggleMany: keys.toggleModelKeysAction,
        limit: keys.limitModelKeyAction,
        revive: keys.reviveModelKeyAction
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

/** The sign-ins kept on this person's sessions' machine. */
export const SIGNIN_ACTIONS = {
    begin: keys.beginAgentSigninAction,
    screen: keys.agentSigninScreenAction,
    answer: keys.answerAgentSigninAction,
    identity: keys.agentSigninIdentityAction,
    capture: keys.captureAgentSigninAction,
    type: keys.typeAgentSigninInputAction,
    signout: keys.beginAgentSignoutAction,
    status: keys.agentSigninStatusAction,
    end: keys.endAgentSigninAction
};
