package app.polaris.mobile;

import android.app.assist.AssistStructure;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.service.autofill.Dataset;
import android.service.autofill.FillResponse;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.autofill.AutofillManager;
import android.view.inputmethod.InlineSuggestionsRequest;
import android.widget.BaseAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Answers the autofill system after the owner has proved who they are: the locked entry becomes the logins for this
 * app or site, and "Search Polaris Vault" becomes the one login picked from the whole list.
 */
public final class VaultFillActivity extends VaultAuthActivity {
    private static final String TAG = "PolarisAutofill";
    private AutofillParse parse;
    private InlineSuggestionsRequest inline;
    private String mode;

    @Override
    @SuppressWarnings("deprecation")
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        mode = getIntent().getStringExtra(AutofillViews.EXTRA_MODE);
        AssistStructure structure = getIntent().getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE);
        if (structure == null) {
            cancel();
            return;
        }
        parse = AutofillParse.of(structure);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            inline = getIntent().getParcelableExtra(AutofillManager.EXTRA_INLINE_SUGGESTIONS_REQUEST);
        }
        open();
    }

    private void open() {
        Vault.Opened opened;
        try {
            opened = Vault.open(this);
        } catch (VaultStore.Locked e) {
            authenticate(this::open, this::cancel);
            return;
        } catch (VaultStore.Lost e) {
            Toast.makeText(this, R.string.vault_lost, Toast.LENGTH_LONG).show();
            cancel();
            return;
        }
        if (AutofillViews.MODE_PICK.equals(mode)) {
            pick(opened);
            return;
        }
        FillResponse response = AutofillViews.unlocked(this, parse, opened.logins, inline);
        setResult(RESULT_OK, new Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response));
        finish();
    }

    private void cancel() {
        setResult(RESULT_CANCELED);
        finish();
    }

    private void pick(Vault.Opened opened) {
        setContentView(R.layout.activity_vault_pick);
        SystemInsets.pad(findViewById(R.id.root));
        String candidate = parse.candidate();
        CheckBox remember = findViewById(R.id.pick_remember);
        remember.setText(getString(R.string.vault_pick_remember, VaultUris.displayName(candidate)));
        TextView empty = findViewById(R.id.pick_empty);
        ListView list = findViewById(R.id.pick_list);
        Rows rows = new Rows(opened.logins);
        list.setAdapter(rows);
        list.setEmptyView(empty);
        list.setOnItemClickListener((parent, view, position, id) -> {
            VaultItems.Login login = rows.shown.get(position);
            Dataset dataset = AutofillViews.login(this, parse, login, null);
            if (dataset == null) {
                Toast.makeText(this, R.string.vault_pick_nothing, Toast.LENGTH_SHORT).show();
                return;
            }
            if (remember.isChecked() && !login.matches(candidate)) rememberFor(opened, login, candidate);
            setResult(RESULT_OK, new Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset));
            finish();
        });
        EditText search = findViewById(R.id.pick_search);
        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                rows.filter(s.toString());
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });
    }

    /** Add this app or site to the login, so it is offered here directly next time. */
    private void rememberFor(Vault.Opened opened, VaultItems.Login login, String candidate) {
        VaultCrypto.Key key = opened.keyFor(login);
        if (key == null) return;
        android.content.Context app = getApplicationContext();
        Vault.WORK.execute(() -> {
            try {
                int status = VaultClient.write(app, login.id, VaultItems.withUri(login, candidate, key));
                if (status >= 200 && status < 300) VaultClient.sync(app);
            } catch (Exception e) {
                Log.w(TAG, "remember failed", e);
            }
        });
    }

    private final class Rows extends BaseAdapter {
        private final List<VaultItems.Login> all;
        final List<VaultItems.Login> shown = new ArrayList<>();

        Rows(List<VaultItems.Login> all) {
            this.all = all;
            shown.addAll(all);
        }

        void filter(String query) {
            String wanted = query.trim().toLowerCase(Locale.ROOT);
            shown.clear();
            for (VaultItems.Login login : all) {
                if (wanted.isEmpty() || contains(login.name, wanted) || contains(login.username, wanted)
                        || login.uris.stream().anyMatch(uri -> contains(uri.uri, wanted))) {
                    shown.add(login);
                }
            }
            notifyDataSetChanged();
        }

        private boolean contains(String value, String wanted) {
            return value != null && value.toLowerCase(Locale.ROOT).contains(wanted);
        }

        @Override
        public int getCount() {
            return shown.size();
        }

        @Override
        public Object getItem(int position) {
            return shown.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convert, ViewGroup parent) {
            View row = convert != null ? convert
                    : getLayoutInflater().inflate(R.layout.vault_pick_row, parent, false);
            VaultItems.Login login = shown.get(position);
            ((TextView) row.findViewById(R.id.row_title)).setText(login.name);
            TextView subtitle = row.findViewById(R.id.row_subtitle);
            subtitle.setText(login.username == null ? "" : login.username);
            subtitle.setVisibility(login.username == null ? View.GONE : View.VISIBLE);
            return row;
        }
    }
}
