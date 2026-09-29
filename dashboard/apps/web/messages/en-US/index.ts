/**
 * US English: the source catalog. Its keys are the ones every other locale must
 * carry, and the types every `t("...")` is checked against.
 *
 * One JSON file per namespace, one line here per file - the catalog test fails
 * when the two disagree.
 */

import api from "./api.json";
import nav from "./nav.json";
import auth from "./auth.json";
import chat from "./chat.json";
import code from "./code.json";
import home from "./home.json";
import mail from "./mail.json";
import admin from "./admin.json";
import tasks from "./tasks.json";
import tools from "./tools.json";
import vault from "./vault.json";
import watch from "./watch.json";
import agents from "./agents.json";
import common from "./common.json";
import deploy from "./deploy.json";
import system from "./system.json";
import account from "./account.json";
import catalog from "./catalog.json";
import notices from "./notices.json";
import analytics from "./analytics.json";
import installed from "./installed.json";
import reference from "./reference.json";
import telemetry from "./telemetry.json";
import compliance from "./compliance.json";
import components from "./components.json";
import deployData from "./deployData.json";
import tasksViews from "./tasksViews.json";
import validation from "./validation.json";
import accountOrgs from "./accountOrgs.json";
import mailCompose from "./mailCompose.json";
import marketplace from "./marketplace.json";
import publicPages from "./publicPages.json";
import tasksDetail from "./tasksDetail.json";
import deployConfig from "./deployConfig.json";
import deployServer from "./deployServer.json";
import mailSettings from "./mailSettings.json";
import deployProject from "./deployProject.json";
import deployService from "./deployService.json";
import accountPrivacy from "./accountPrivacy.json";
import deploySettings from "./deploySettings.json";
import accountSecurity from "./accountSecurity.json";
import accountNotifications from "./accountNotifications.json";

export default {
    account,
    accountNotifications,
    accountOrgs,
    accountPrivacy,
    accountSecurity,
    admin,
    agents,
    analytics,
    api,
    auth,
    catalog,
    chat,
    code,
    common,
    compliance,
    components,
    deploy,
    deployConfig,
    deployData,
    deployProject,
    deployServer,
    deployService,
    deploySettings,
    home,
    installed,
    mail,
    mailCompose,
    mailSettings,
    marketplace,
    nav,
    notices,
    publicPages,
    reference,
    system,
    tasks,
    tasksDetail,
    tasksViews,
    telemetry,
    tools,
    validation,
    vault,
    watch
};
