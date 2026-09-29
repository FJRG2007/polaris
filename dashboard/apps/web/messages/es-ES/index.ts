/**
 * Spanish as written in Spain. Same namespaces and keys as en-US - a missing one
 * is a type error in `messages/index.ts` and a failure in the catalog test.
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
