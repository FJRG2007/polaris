package app.polaris.mobile;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;

/**
 * "Save to Polaris Vault": what another app's login screen just took, saved as a new login - or, when this vault
 * already has that username for that app or site, its password changed. Reached only from the autofill save offer.
 */
public final class VaultSaveActivity extends VaultAuthActivity {
    private static final String TAG = "PolarisAutofill";
    private static final String EXTRA_CANDIDATE = "polaris.vault.candidate";
    private static final String EXTRA_USERNAME = "polaris.vault.username";
    private static final String EXTRA_PASSWORD = "polaris.vault.password";
    private static final String EXTRA_NAME = "polaris.vault.name";

    static Intent intent(Context context, String candidate, String username, String password, String name) {
        return new Intent(context, VaultSaveActivity.class)
                .putExtra(EXTRA_CANDIDATE, candidate)
                .putExtra(EXTRA_USERNAME, username)
                .putExtra(EXTRA_PASSWORD, password)
                .putExtra(EXTRA_NAME, name);
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        open();
    }

    private void open() {
        Vault.Opened opened;
        try {
            opened = Vault.open(this);
        } catch (VaultStore.Locked e) {
            authenticate(this::open, this::finish);
            return;
        } catch (VaultStore.Lost e) {
            Toast.makeText(this, R.string.vault_lost, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        ask(opened);
    }

    private void ask(Vault.Opened opened) {
        String candidate = getIntent().getStringExtra(EXTRA_CANDIDATE);
        String username = getIntent().getStringExtra(EXTRA_USERNAME);
        String password = getIntent().getStringExtra(EXTRA_PASSWORD);
        if (candidate == null || password == null || password.isEmpty()) {
            finish();
            return;
        }
        VaultItems.Login existing = VaultItems.existing(opened.logins, candidate, username);
        if (existing != null && password.equals(existing.password)) {
            // Nothing new: the vault already has exactly this.
            finish();
            return;
        }
        View body = getLayoutInflater().inflate(R.layout.dialog_vault_save, null);
        EditText name = body.findViewById(R.id.save_name);
        TextView detail = body.findViewById(R.id.save_detail);
        String suggested = getIntent().getStringExtra(EXTRA_NAME);
        name.setText(existing != null ? existing.name : suggested == null ? "" : suggested);
        name.setVisibility(existing != null ? View.GONE : View.VISIBLE);
        String who = username == null || username.isEmpty() ? getString(R.string.vault_save_no_username) : username;
        detail.setText(existing != null ? getString(R.string.vault_save_update_detail, who, existing.name)
                : getString(R.string.vault_save_new_detail, who, VaultUris.displayName(candidate)));
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(existing != null ? R.string.vault_save_update_title : R.string.vault_save_title)
                .setView(body)
                .setPositiveButton(existing != null ? R.string.vault_save_update : R.string.vault_save, null)
                .setNegativeButton(R.string.vault_save_not_now, (d, w) -> finish())
                .setOnCancelListener(d -> finish())
                .create();
        dialog.setOnShowListener(shown -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String title = name.getText().toString().trim();
            if (existing == null && title.isEmpty()) {
                name.setError(getString(R.string.vault_save_name_it));
                return;
            }
            dialog.dismiss();
            write(opened, existing, title, username, password, candidate);
        }));
        dialog.show();
    }

    private void write(Vault.Opened opened, VaultItems.Login existing, String title, String username, String password,
            String candidate) {
        Context app = getApplicationContext();
        Handler main = new Handler(Looper.getMainLooper());
        Vault.WORK.execute(() -> {
            int said;
            try {
                JSONObject item;
                String id = null;
                if (existing != null) {
                    VaultCrypto.Key key = opened.keyFor(existing);
                    if (key == null) throw new IllegalStateException("no item key");
                    item = VaultItems.withNewPassword(existing, password, key);
                    id = existing.id;
                } else {
                    item = VaultItems.newLogin(title, username, password, candidate, opened.key);
                }
                int status = VaultClient.write(app, id, item);
                if (status >= 200 && status < 300) {
                    said = R.string.vault_saved;
                    // Saved either way; a sync that fails here is caught up on the next fill.
                    Vault.syncNow(app, null);
                } else {
                    said = status == 409 ? R.string.vault_save_conflict : R.string.vault_save_failed;
                }
            } catch (VaultClient.Ended e) {
                VaultStore.disconnect(app);
                said = R.string.vault_lost;
            } catch (Exception e) {
                Log.w(TAG, "save failed", e);
                said = R.string.vault_save_failed;
            }
            int message = said;
            main.post(() -> Toast.makeText(app, message, Toast.LENGTH_LONG).show());
        });
        finish();
    }
}
