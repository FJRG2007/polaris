package app.polaris.mobile;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.format.DateUtils;
import android.util.Log;
import android.view.View;
import android.view.autofill.AutofillManager;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;
import java.io.IOException;
import java.security.GeneralSecurityException;

/**
 * Polaris Vault on this phone: connect it (approved on the vault's own page, inside this app), make Polaris the
 * phone's autofill service, and see or end the connection. Also what the phone's autofill settings open for Polaris.
 */
public final class VaultActivity extends VaultAuthActivity {
    private static final String TAG = "PolarisVault";
    private TextView status;
    private TextView problem;
    private Button primary;
    private Button secondary;
    private Button tertiary;
    private boolean sealing;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_vault);
        SystemInsets.pad(findViewById(R.id.root));
        status = findViewById(R.id.vault_status);
        problem = findViewById(R.id.vault_problem);
        primary = findViewById(R.id.vault_primary);
        secondary = findViewById(R.id.vault_secondary);
        tertiary = findViewById(R.id.vault_tertiary);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Vault.listen(this::render);
        render();
    }

    @Override
    protected void onPause() {
        super.onPause();
        Vault.listen(null);
    }

    private void render() {
        problem.setVisibility(View.GONE);
        secondary.setVisibility(View.GONE);
        tertiary.setVisibility(View.GONE);
        primary.setVisibility(View.VISIBLE);
        primary.setEnabled(true);

        if (!VaultStore.deviceSecure(this)) {
            status.setText(R.string.vault_status_no_lock);
            primary.setText(R.string.vault_open_security);
            primary.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS)));
            return;
        }

        Vault.Stage stage = Vault.stage();
        if (stage == Vault.Stage.APPROVED) {
            status.setText(R.string.vault_status_sealing);
            primary.setVisibility(View.GONE);
            seal();
            return;
        }
        if (stage == Vault.Stage.WAITING) {
            status.setText(getString(R.string.vault_status_waiting, Vault.userCode()));
            primary.setText(R.string.vault_open_approval);
            primary.setOnClickListener(v -> openApproval());
            secondary.setVisibility(View.VISIBLE);
            secondary.setText(R.string.vault_cancel);
            secondary.setOnClickListener(v -> {
                Vault.cancelConnect();
                render();
            });
            return;
        }
        if (stage == Vault.Stage.DENIED || stage == Vault.Stage.EXPIRED || stage == Vault.Stage.FAILED) {
            problem.setVisibility(View.VISIBLE);
            problem.setText(stage == Vault.Stage.DENIED ? R.string.vault_denied
                    : stage == Vault.Stage.EXPIRED ? R.string.vault_expired : R.string.vault_failed);
        }

        if (!VaultStore.connected(this)) {
            String origin = ServerStore.origin(this);
            if (origin == null) {
                status.setText(R.string.vault_status_no_server);
                primary.setText(R.string.hosts_add);
                primary.setOnClickListener(v -> startActivity(new Intent(this, ServerActivity.class)));
                return;
            }
            status.setText(getString(R.string.vault_status_disconnected, Uri.parse(origin).getHost()));
            primary.setText(R.string.vault_connect);
            primary.setOnClickListener(v -> connect(origin));
            return;
        }

        String host = Uri.parse(VaultStore.origin(this)).getHost();
        long last = VaultStore.lastSync(this);
        String when = last == 0 ? getString(R.string.vault_never_synced)
                : DateUtils.getRelativeTimeSpanString(last, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
                        .toString();
        boolean enabled = autofillEnabled();
        status.setText(getString(enabled ? R.string.vault_status_on : R.string.vault_status_off, host, when));
        if (!enabled) {
            primary.setText(R.string.vault_turn_on);
            primary.setOnClickListener(v -> turnOn());
        } else {
            primary.setText(R.string.vault_sync);
            primary.setOnClickListener(v -> sync());
        }
        secondary.setVisibility(View.VISIBLE);
        secondary.setText(enabled ? R.string.vault_change_service : R.string.vault_sync);
        secondary.setOnClickListener(v -> {
            if (enabled) turnOn();
            else sync();
        });
        tertiary.setVisibility(View.VISIBLE);
        tertiary.setText(R.string.vault_disconnect);
        tertiary.setOnClickListener(v -> confirmDisconnect());
    }

    private boolean autofillEnabled() {
        AutofillManager autofill = getSystemService(AutofillManager.class);
        return autofill != null && autofill.hasEnabledAutofillServices();
    }

    private void turnOn() {
        Intent ask = new Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE,
                Uri.parse("package:" + getPackageName()));
        try {
            startActivity(ask);
        } catch (android.content.ActivityNotFoundException e) {
            // Some phones hide the direct request; their autofill list is under the general settings.
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private void connect(String origin) {
        primary.setEnabled(false);
        Vault.startConnect(this, origin, page -> {
            if (page == null) {
                problem.setVisibility(View.VISIBLE);
                problem.setText(R.string.vault_server_silent);
                primary.setEnabled(true);
                return;
            }
            render();
            openApproval();
        });
    }

    /** The vault's own approval page, in this app's window on the same Polaris, where its session already is. */
    private void openApproval() {
        String origin = ServerStore.origin(this);
        String code = Vault.userCode();
        if (origin == null || code == null) return;
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(origin + "/vault/authorize?code=" + Uri.encode(code)),
                this, MainActivity.class));
    }

    private void seal() {
        if (sealing) return;
        sealing = true;
        try {
            Vault.finishConnect(this);
            sealing = false;
            Toast.makeText(this, R.string.vault_connected, Toast.LENGTH_SHORT).show();
            render();
        } catch (VaultStore.Locked e) {
            authenticate(() -> {
                sealing = false;
                render();
            }, () -> {
                sealing = false;
                Vault.cancelConnect();
                render();
            });
        } catch (GeneralSecurityException | IOException e) {
            Log.w(TAG, "seal failed", e);
            sealing = false;
            Vault.cancelConnect();
            render();
            problem.setVisibility(View.VISIBLE);
            problem.setText(R.string.vault_failed);
        }
    }

    private void sync() {
        primary.setEnabled(false);
        Vault.syncNow(this, (ok, ended) -> {
            if (ended) Toast.makeText(this, R.string.vault_lost, Toast.LENGTH_LONG).show();
            else if (!ok) Toast.makeText(this, R.string.vault_sync_failed, Toast.LENGTH_LONG).show();
            render();
        });
    }

    private void confirmDisconnect() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.vault_disconnect_title)
                .setMessage(R.string.vault_disconnect_message)
                .setPositiveButton(R.string.vault_disconnect, (d, w) -> {
                    VaultStore.disconnect(this);
                    render();
                })
                .setNegativeButton(R.string.hosts_cancel, null)
                .show();
    }
}
