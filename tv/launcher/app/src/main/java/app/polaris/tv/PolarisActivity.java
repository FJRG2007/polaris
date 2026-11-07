package app.polaris.tv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/** Connecting this TV to a Polaris, and what it shows once connected. Nothing here is needed to use the TV. */
public final class PolarisActivity extends Activity {

    private static final int QR_SIZE = 320;

    private final Handler main = new Handler(Looper.getMainLooper());
    private View connectForm;
    private View pairingPanel;
    private View connectedPanel;
    private EditText address;
    private TextView message;
    private TextView code;
    private TextView verifyAddress;
    private ImageView qr;
    private TextView accountLine;
    private TextView instanceLine;
    private TextView countsLine;
    private TextView addressLine;
    /** The address to link to, from the installer. */
    static final String EXTRA_ORIGIN = "origin";
    private volatile boolean closed;
    private int attempt;

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(LauncherLocale.wrap(base));
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_polaris);
        connectForm = findViewById(R.id.polarisConnectForm);
        pairingPanel = findViewById(R.id.polarisPairing);
        connectedPanel = findViewById(R.id.polarisConnected);
        address = findViewById(R.id.polarisAddress);
        message = findViewById(R.id.polarisMessage);
        code = findViewById(R.id.polarisCode);
        verifyAddress = findViewById(R.id.polarisVerifyAddress);
        qr = findViewById(R.id.polarisQr);
        accountLine = findViewById(R.id.polarisAccount);
        instanceLine = findViewById(R.id.polarisInstance);
        countsLine = findViewById(R.id.polarisCounts);
        addressLine = findViewById(R.id.polarisAddressInUse);
        findViewById(R.id.polarisConnect).setOnClickListener(v -> connect());
        findViewById(R.id.polarisCancel).setOnClickListener(v -> showForm(null));
        findViewById(R.id.polarisDisconnect).setOnClickListener(v -> disconnect());
        address.setOnEditorActionListener((view, action, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER;
            if (action != EditorInfo.IME_ACTION_GO && !enter) return false;
            connect();
            return true;
        });
        // A TV's on-screen keyboard covers most of the screen and stays up after Go unless it is put away.
        address.setOnFocusChangeListener((view, focused) -> { if (!focused) hideKeyboard(); });
        if (PolarisLink.connected(this)) {
            showConnected();
            return;
        }
        showForm(null);
        // Opened by the installer (the LinkFromInstall alias): its Polaris filled in, one press from the code. The
        // press is the person's: an app holding the same permission could open the alias with an address of its own.
        String from = getIntent().getStringExtra(EXTRA_ORIGIN);
        String origin = from == null ? null : PolarisFailover.readTyped(from);
        if (origin != null) {
            address.setText(origin);
            say(getString(R.string.polaris_from_install, origin));
            findViewById(R.id.polarisConnect).requestFocus();
        }
    }

    @Override
    protected void onDestroy() {
        closed = true;
        attempt++;
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void show(View panel) {
        connectForm.setVisibility(panel == connectForm ? View.VISIBLE : View.GONE);
        pairingPanel.setVisibility(panel == pairingPanel ? View.VISIBLE : View.GONE);
        connectedPanel.setVisibility(panel == connectedPanel ? View.VISIBLE : View.GONE);
    }

    private void say(String words) {
        message.setText(words);
        message.setVisibility(words == null ? View.GONE : View.VISIBLE);
    }

    private void showForm(String words) {
        attempt++;
        show(connectForm);
        say(words);
        address.requestFocus();
    }

    /** Puts the on-screen keyboard away, so the code and QR it would cover are seen. */
    private void hideKeyboard() {
        InputMethodManager keyboard = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(address.getWindowToken(), 0);
    }

    private void connect() {
        hideKeyboard();
        String origin = PolarisFailover.readTyped(address.getText().toString());
        if (origin == null) {
            say(getString(R.string.polaris_bad_address));
            return;
        }
        int mine = ++attempt;
        say(getString(R.string.polaris_connecting));
        new Thread(() -> {
            String instance = PolarisLink.learn(origin);
            try {
                PolarisLink.Pairing pairing = PolarisLink.pair(origin);
                main.post(() -> { if (mine == attempt) showPairing(mine, origin, instance, pairing); });
            } catch (IOException failed) {
                main.post(() -> {
                    if (mine == attempt) say(getString(R.string.polaris_no_answer, origin));
                });
            }
        }, "polaris-connect").start();
    }

    private void showPairing(int mine, String origin, String instance, PolarisLink.Pairing pairing) {
        hideKeyboard();
        address.clearFocus();
        show(pairingPanel);
        say(plainWarning(origin));
        String shown = pairing.userCode.length() == 8
                ? pairing.userCode.substring(0, 4) + "-" + pairing.userCode.substring(4) : pairing.userCode;
        code.setText(shown);
        verifyAddress.setText(pairing.verifyUrl.replaceFirst("^https?://", ""));
        Bitmap image = qrOf(pairing.approveUrl);
        qr.setImageBitmap(image);
        qr.setVisibility(image == null ? View.GONE : View.VISIBLE);
        findViewById(R.id.polarisCancel).requestFocus();
        main.postDelayed(() -> poll(mine, origin, instance, pairing), pairing.pollMs);
    }

    private void poll(int mine, String origin, String instance, PolarisLink.Pairing pairing) {
        if (mine != attempt) return;
        if (System.currentTimeMillis() > pairing.expiresAt) {
            showForm(getString(R.string.polaris_expired));
            return;
        }
        new Thread(() -> {
            String status;
            try {
                status = PolarisLink.claim(this, origin, instance, pairing);
            } catch (IOException blip) {
                status = "pending";   // A Wi-Fi blip while somebody approves must not throw the sign-in away.
            }
            String answer = status;
            main.post(() -> {
                if (mine != attempt) return;
                switch (answer) {
                    case "approved": goHome(); break;
                    case "denied": showForm(getString(R.string.polaris_denied)); break;
                    case "expired": showForm(getString(R.string.polaris_expired)); break;
                    default: main.postDelayed(() -> poll(mine, origin, instance, pairing), pairing.pollMs);
                }
            });
        }, "polaris-claim").start();
    }

    /**
     * Linked: back to Home rather than this screen, which has nothing left to do. Home greets by the account's
     * name and, unless a language was picked on the TV, switches to the account's on its first answer.
     */
    private void goHome() {
        attempt++;
        hideKeyboard();
        // Opened from the installer this screen may be the only one in its task: bring Home up, not just close.
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        finish();
    }

    private static Bitmap qrOf(String text) {
        try {
            BitMatrix matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, QR_SIZE, QR_SIZE);
            int width = matrix.getWidth();
            int height = matrix.getHeight();
            int[] pixels = new int[width * height];
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) pixels[y * width + x] = matrix.get(x, y) ? Color.BLACK : Color.WHITE;
            }
            return Bitmap.createBitmap(pixels, width, height, Bitmap.Config.RGB_565);
        } catch (WriterException tooLong) {
            return null;   // The code and the address below it still do the job.
        }
    }

    private void showConnected() {
        attempt++;
        show(connectedPanel);
        say(null);
        findViewById(R.id.polarisDisconnect).requestFocus();
        accountLine.setText(R.string.polaris_loading);
        instanceLine.setText("");
        countsLine.setText("");
        addressLine.setText("");
        int mine = attempt;
        new Thread(() -> {
            PolarisLink link = PolarisLink.load(this);
            if (link == null) {
                PolarisLink.forget(this);
                main.post(() -> { if (mine == attempt) showForm(getString(R.string.polaris_sign_in_lost)); });
                return;
            }
            PolarisLink.State state = null;
            boolean reached = true;
            try {
                state = link.state();
            } catch (IOException unreachable) {
                reached = false;
            }
            if (reached && state == null) {
                PolarisLink.forget(this);
                main.post(() -> { if (mine == attempt) showForm(getString(R.string.polaris_sign_in_lost)); });
                return;
            }
            PolarisLink.State shown = state;
            main.post(() -> { if (mine == attempt) render(link, shown); });
        }, "polaris-state").start();
    }

    private void render(PolarisLink link, PolarisLink.State state) {
        String host = link.addressInUse().replaceFirst("^https?://", "");
        if (state == null) {
            accountLine.setText(R.string.polaris_unreachable);
            addressLine.setText(host);
        } else {
            accountLine.setText(state.accountName);
            instanceLine.setText(state.instanceName);
            countsLine.setText(getResources().getQuantityString(R.plurals.polaris_unread, state.unread, state.unread)
                    + "  -  "
                    + getResources().getQuantityString(R.plurals.polaris_alerts, state.alerts, state.alerts));
            addressLine.setText(link.onLocalAddress() ? getString(R.string.polaris_on_local, host) : host);
        }
        List<String> notes = new ArrayList<>();
        if (!link.refused().isEmpty()) notes.add(getString(R.string.polaris_refused, PolarisLink.join(link.refused())));
        else if (!link.untrusted().isEmpty()) notes.add(getString(R.string.polaris_untrusted, PolarisLink.join(link.untrusted())));
        String warning = plainWarning(link.addressInUse());
        if (warning != null) notes.add(warning);
        say(notes.isEmpty() ? null : String.join("\n", notes));
    }

    private String plainWarning(String origin) {
        if (!PolarisFailover.plain(origin)) return null;
        return getString(R.string.polaris_plain_http, origin.replaceFirst("^https?://", ""));
    }

    private void disconnect() {
        int mine = ++attempt;
        new Thread(() -> {
            PolarisLink link = PolarisLink.load(this);
            if (link != null) link.disconnect();
            else PolarisLink.forget(this);
            main.post(() -> { if (mine == attempt && !closed) showForm(null); });
        }, "polaris-disconnect").start();
    }
}
