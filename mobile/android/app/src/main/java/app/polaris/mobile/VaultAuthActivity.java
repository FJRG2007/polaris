package app.polaris.mobile;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import androidx.annotation.RequiresApi;

/**
 * A screen that may have to ask the owner to prove who they are before the vault key opens: the phone's own prompt
 * (fingerprint, face, or the PIN, pattern or password), never a password of this app's. Also what gates approving a
 * sign-in ({@link SignInConfirmActivity}).
 */
abstract class VaultAuthActivity extends Activity {
    private static final int CONFIRM = 41;
    private Runnable confirmed;
    private Runnable refused;

    final void authenticate(Runnable ok, Runnable no) {
        confirmed = ok;
        refused = no;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            prompt();
            return;
        }
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        @SuppressWarnings("deprecation")
        Intent ask = keyguard == null ? null
                : keyguard.createConfirmDeviceCredentialIntent(promptTitle(), promptSubtitle());
        if (ask == null) {
            settle(false);
            return;
        }
        startActivityForResult(ask, CONFIRM);
    }

    /** What the phone's prompt says it is for. A screen that is not the vault's says its own. */
    String promptTitle() {
        return getString(R.string.vault_unlock_title);
    }

    String promptSubtitle() {
        return getString(R.string.vault_unlock_subtitle);
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private void prompt() {
        BiometricPrompt prompt = new BiometricPrompt.Builder(this)
                .setTitle(promptTitle())
                .setSubtitle(promptSubtitle())
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG
                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build();
        prompt.authenticate(new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                settle(true);
            }

            @Override
            public void onAuthenticationError(int code, CharSequence message) {
                settle(false);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == CONFIRM) {
            settle(resultCode == RESULT_OK);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void settle(boolean ok) {
        Runnable next = ok ? confirmed : refused;
        confirmed = null;
        refused = null;
        if (next != null) next.run();
    }
}
