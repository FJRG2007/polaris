package app.polaris.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Where the phone is told which Polaris to open: one field for the address, checked against the server before it is
 * kept, with the reason on screen when it is not one.
 */
public final class ServerActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private EditText address;
    private Button connect;
    private ProgressBar busy;
    private TextView problem;
    private int attempt;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_server);
        address = findViewById(R.id.address);
        connect = findViewById(R.id.connect);
        busy = findViewById(R.id.busy);
        problem = findViewById(R.id.problem);
        String current = ServerStore.origin(this);
        if (current != null) address.setText(current);
        connect.setOnClickListener(view -> submit());
        address.setOnEditorActionListener((view, action, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER;
            if (action == EditorInfo.IME_ACTION_GO || enter) {
                submit();
                return true;
            }
            return false;
        });
    }

    private void submit() {
        String origin = ServerAddress.origin(address.getText().toString());
        if (origin == null) {
            show(getString(R.string.server_invalid));
            return;
        }
        int mine = ++attempt;
        setBusy(true);
        problem.setVisibility(View.GONE);
        worker.execute(() -> {
            ServerProbe.Verdict verdict = ServerProbe.probe(origin);
            main.post(() -> {
                if (mine != attempt || isFinishing()) return;
                setBusy(false);
                if (verdict == ServerProbe.Verdict.POLARIS) {
                    ServerStore.save(this, origin);
                    startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
                    finish();
                } else {
                    show(getString(reason(verdict)));
                }
            });
        });
    }

    private static int reason(ServerProbe.Verdict verdict) {
        switch (verdict) {
            case STARTING:
                return R.string.server_starting;
            case REDIRECTS:
                return R.string.server_redirects;
            case UNREACHABLE:
                return R.string.server_unreachable;
            default:
                return R.string.server_not_polaris;
        }
    }

    private void setBusy(boolean on) {
        busy.setVisibility(on ? View.VISIBLE : View.GONE);
        connect.setEnabled(!on);
        address.setEnabled(!on);
    }

    private void show(String text) {
        problem.setText(text);
        problem.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }
}
