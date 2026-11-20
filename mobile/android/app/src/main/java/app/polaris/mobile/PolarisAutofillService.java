package app.polaris.mobile;

import android.app.assist.AssistStructure;
import android.content.Intent;
import android.os.Build;
import android.os.CancellationSignal;
import android.service.autofill.AutofillService;
import android.service.autofill.FillCallback;
import android.service.autofill.FillContext;
import android.service.autofill.FillRequest;
import android.service.autofill.SaveCallback;
import android.service.autofill.SaveRequest;
import android.util.Log;
import android.view.inputmethod.InlineSuggestionsRequest;
import java.util.List;

/**
 * Polaris Vault as the phone's autofill service: logins offered under the boxes of other apps and browsers, and a
 * save offered when a new one is typed. The shape is the one Bitwarden's Android app (bitwarden/android,
 * `data/autofill`) and Keyguard settled on: parse the screen, answer straight away with the matching logins when the
 * vault opens, and with one "unlock" entry when it does not - the owner proves who they are and the same screen
 * answers.
 */
public final class PolarisAutofillService extends AutofillService {
    private static final String TAG = "PolarisAutofill";

    @Override
    public void onFillRequest(FillRequest request, CancellationSignal cancel, FillCallback callback) {
        try {
            if (!VaultStore.connected(this)) {
                callback.onSuccess(null);
                return;
            }
            List<FillContext> contexts = request.getFillContexts();
            AssistStructure structure = contexts.get(contexts.size() - 1).getStructure();
            AutofillParse parse = AutofillParse.of(structure);
            if (!parse.fillable()) {
                callback.onSuccess(null);
                return;
            }
            InlineSuggestionsRequest inline =
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? request.getInlineSuggestionsRequest() : null;
            Vault.syncIfStale(this);
            Vault.Opened opened;
            try {
                opened = Vault.open(this);
            } catch (VaultStore.Locked e) {
                callback.onSuccess(AutofillViews.locked(this, parse, inline));
                return;
            }
            callback.onSuccess(AutofillViews.unlocked(this, parse, opened.logins, inline));
        } catch (VaultStore.Lost e) {
            // The phone's lock screen was removed or reset and the sealed key with it; the vault screen says so.
            callback.onSuccess(null);
        } catch (RuntimeException e) {
            Log.w(TAG, "fill failed", e);
            callback.onSuccess(null);
        }
    }

    @Override
    public void onSaveRequest(SaveRequest request, SaveCallback callback) {
        try {
            List<FillContext> contexts = request.getFillContexts();
            AssistStructure structure = contexts.get(contexts.size() - 1).getStructure();
            AutofillParse parse = AutofillParse.of(structure);
            if (!VaultStore.connected(this) || parse.passwordValue == null || parse.passwordValue.isEmpty()) {
                callback.onSuccess();
                return;
            }
            Intent save = VaultSaveActivity.intent(this, parse.candidate(), parse.usernameValue, parse.passwordValue,
                    appLabel(parse));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                callback.onSuccess(android.app.PendingIntent.getActivity(this, 0, save,
                        android.app.PendingIntent.FLAG_CANCEL_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE)
                        .getIntentSender());
            } else {
                // Android 8 starts its own activities from a service without asking.
                startActivity(save.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                callback.onSuccess();
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "save failed", e);
            callback.onFailure(getString(R.string.vault_save_failed));
        }
    }

    /** What a new login is called: the site's host, or the app's own name. */
    private String appLabel(AutofillParse parse) {
        String candidate = parse.candidate();
        if (!candidate.startsWith(VaultUris.APP_SCHEME)) return VaultUris.displayName(candidate);
        try {
            android.content.pm.PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(parse.packageName, 0)).toString();
        } catch (android.content.pm.PackageManager.NameNotFoundException e) {
            return parse.packageName;
        }
    }
}
