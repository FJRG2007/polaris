/**
 * US English: the source catalog. Its keys are the ones every other locale must
 * carry, and the types every `t("...")` is checked against.
 *
 * One JSON file per namespace, one line here per file - the catalog test fails
 * when the two disagree.
 */

import nav from "./nav.json";
import auth from "./auth.json";
import chat from "./chat.json";
import home from "./home.json";
import admin from "./admin.json";
import common from "./common.json";
import account from "./account.json";
import validation from "./validation.json";
import accountOrgs from "./accountOrgs.json";
import publicPages from "./publicPages.json";
import accountPrivacy from "./accountPrivacy.json";
import accountSecurity from "./accountSecurity.json";
import accountNotifications from "./accountNotifications.json";

export default {
    account,
    accountNotifications,
    accountOrgs,
    accountPrivacy,
    accountSecurity,
    admin,
    auth,
    chat,
    common,
    home,
    nav,
    publicPages,
    validation
};
