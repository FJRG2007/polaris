package app.polaris.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.widget.RemoteViews;

/**
 * A door on the home screen: one press opens it.
 *
 * The press goes to Polaris as this phone, signed with its own key against a fresh challenge, and Polaris opens the
 * door through Places with every check its screen makes - a door that was not lent to the phone's owner is refused
 * there, not here. The widget draws only what it was told: the door's name, and what the last press did.
 */
public final class DoorWidget extends AppWidgetProvider {
    static final String ACTION_OPEN = "app.polaris.mobile.DOOR_OPEN";
    private static final String PREFS = "door-widgets";
    /** How long what a press did stays on the widget before it offers the door again. */
    private static final long SETTLE_MS = 6_000;

    /** Remember which door this widget opens. */
    static void choose(Context context, int widgetId, String deviceId, String name) {
        prefs(context).edit().putString(widgetId + ":id", deviceId).putString(widgetId + ":name", name).apply();
        draw(context, widgetId, null);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) draw(context, widgetId, null);
    }

    @Override
    public void onDeleted(Context context, int[] widgetIds) {
        SharedPreferences.Editor editor = prefs(context).edit();
        for (int widgetId : widgetIds) editor.remove(widgetId + ":id").remove(widgetId + ":name");
        editor.apply();
    }

    /**
     * One press, handed over by {@link DoorPress}. It never arrives here: this receiver is exported so the launcher can
     * reach it, which means any app on the phone could send it a broadcast, and a door must open only from the widget.
     */
    static void press(Context context, Intent intent, BroadcastReceiver.PendingResult pending) {
        int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        String deviceId = prefs(context).getString(widgetId + ":id", null);
        String origin = ServerStore.origin(context);
        if (deviceId == null || origin == null || !deviceId.matches("[0-9a-f-]{36}")) {
            draw(context, widgetId, context.getString(R.string.door_signed_out));
            pending.finish();
            return;
        }
        draw(context, widgetId, context.getString(R.string.door_opening));
        Context app = context.getApplicationContext();
        new Thread(() -> {
            String said;
            try {
                PolarisHttp.Answer answer = PolarisHttp.signed(app, origin, origin + "/api/mobile/doors/" + deviceId + "/open",
                        "door-open", deviceId, app.getString(R.string.door_failed), 64 * 1024);
                said = answer.json().optString("text", app.getString(R.string.door_opened));
            } catch (PolarisHttp.Refused refused) {
                said = refused.status == 401 ? app.getString(R.string.door_signed_out) : refused.getMessage();
            } catch (Exception failed) {
                said = app.getString(R.string.door_failed);
            }
            draw(app, widgetId, said);
            // Back to offering the door, a moment later, from the main thread so the async result can end now.
            new Handler(Looper.getMainLooper()).postDelayed(() -> draw(app, widgetId, null), SETTLE_MS);
            pending.finish();
        }, "door-widget").start();
    }

    /** Draw one widget: its door, and `status` or the offer to open it. */
    static void draw(Context context, int widgetId, String status) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_door);
        String name = prefs(context).getString(widgetId + ":name", null);
        views.setTextViewText(R.id.door_name, name != null ? name : context.getString(R.string.door_widget_label));
        views.setTextViewText(R.id.door_status, status != null ? status : context.getString(R.string.door_tap));
        Intent press = new Intent(context, DoorPress.class)
                .setAction(ACTION_OPEN)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        views.setOnClickPendingIntent(R.id.door_widget, PendingIntent.getBroadcast(context, widgetId, press,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        AppWidgetManager.getInstance(context).updateAppWidget(widgetId, views);
    }

    /** Every door widget, redrawn: after signing in, say, so none keeps saying it is signed out. */
    static void redrawAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        for (int widgetId : manager.getAppWidgetIds(new ComponentName(context, DoorWidget.class))) {
            draw(context, widgetId, null);
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
