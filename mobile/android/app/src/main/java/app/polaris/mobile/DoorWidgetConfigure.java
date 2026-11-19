package app.polaris.mobile;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Which door a new widget opens: the doors this person can open on their Polaris, read from it, one press each.
 * Signed out, or with no Polaris chosen yet, it says so and offers to open the app.
 */
public final class DoorWidgetConfigure extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private LinearLayout list;
    private ProgressBar loading;
    private TextView note;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // Backing out adds nothing to the home screen.
        setResult(RESULT_CANCELED);
        Bundle extras = getIntent().getExtras();
        if (extras != null) {
            widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        }
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText(R.string.door_pick_title);
        title.setTextColor(getColor(R.color.foreground));
        title.setTextSize(22);
        list.addView(title);
        note = new TextView(this);
        note.setTextColor(getColor(R.color.muted));
        note.setTextSize(14);
        note.setPadding(0, pad / 3, 0, pad / 2);
        note.setVisibility(View.GONE);
        list.addView(note);
        loading = new ProgressBar(this);
        list.addView(loading, new LinearLayout.LayoutParams(-2, -2));
        ScrollView scroll = new ScrollView(this);
        SystemInsets.pad(scroll);
        scroll.addView(list);
        setContentView(scroll);

        String origin = ServerStore.origin(this);
        if (origin == null) {
            signedOut();
            return;
        }
        new Thread(() -> read(origin), "door-list").start();
    }

    private void read(String origin) {
        try {
            PolarisHttp.Answer answer = PolarisHttp.request(this, origin + "/api/mobile/doors", "GET", null, 256 * 1024);
            if (answer.status == 401 || answer.status == 403) {
                main.post(this::signedOut);
                return;
            }
            if (answer.status >= 400) throw new IllegalStateException("status " + answer.status);
            JSONObject body = answer.json();
            JSONArray doors = body.optJSONArray("doors");
            main.post(() -> show(doors == null ? new JSONArray() : doors));
        } catch (Exception failed) {
            main.post(() -> say(getString(R.string.door_list_failed)));
        }
    }

    private void show(JSONArray doors) {
        if (isFinishing()) return;
        loading.setVisibility(View.GONE);
        if (doors.length() == 0) {
            say(getString(R.string.door_none));
            return;
        }
        for (int at = 0; at < doors.length(); at++) {
            JSONObject door = doors.optJSONObject(at);
            if (door == null) continue;
            String id = door.optString("id");
            String name = door.optString("name");
            if (!id.matches("[0-9a-f-]{36}") || name.isEmpty()) continue;
            Button pick = new Button(this, null, 0, R.style.Widget_Polaris_Button_Ghost);
            pick.setText(name);
            pick.setTextColor(getColor(R.color.foreground));
            pick.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
            pick.setOnClickListener(view -> pick(id, name));
            list.addView(pick, new LinearLayout.LayoutParams(-1, -2));
        }
    }

    private void pick(String deviceId, String name) {
        DoorWidget.choose(this, widgetId, deviceId, name);
        setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        finish();
    }

    private void signedOut() {
        say(getString(R.string.door_signed_out));
        Button open = new Button(this);
        open.setText(R.string.door_open_app);
        open.setOnClickListener(view -> {
            startActivity(new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            finish();
        });
        list.addView(open, new LinearLayout.LayoutParams(-1, -2));
    }

    private void say(String text) {
        if (isFinishing()) return;
        loading.setVisibility(View.GONE);
        note.setText(text);
        note.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
