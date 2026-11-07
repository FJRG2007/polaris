package app.polaris.tv;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/**
 * "Who's watching?": a full-screen overlay over Home with a tile per profile, then Add profile and Manage
 * profiles. Left and Right move, OK picks. Back does nothing on a cold start (somebody has to be chosen) and
 * returns to the current profile when it was opened from Switch profile.
 */
final class ProfilePicker {
    interface Listener {
        void onPicked(Profiles.Profile profile);

        void onAdd();

        void onManage();
    }

    private ProfilePicker() {
    }

    /** The name shown for a profile: its own, or the translated default for a migrated one without a name. */
    static String displayName(Context ctx, Profiles.Profile profile) {
        return profile.name.isEmpty() ? ctx.getString(R.string.profile_default_name) : profile.name;
    }

    /** A coloured circle with the profile's initial, {@code sizePx} across. */
    static TextView avatar(Context ctx, Profiles.Profile profile, int sizePx) {
        TextView view = new TextView(ctx);
        String name = displayName(ctx, profile);
        int end = name.isEmpty() ? 0 : name.offsetByCodePoints(0, 1);
        view.setText(name.substring(0, end).toUpperCase(java.util.Locale.getDefault()));
        view.setTextColor(Color.WHITE);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, sizePx * 0.45f);
        view.setGravity(Gravity.CENTER);
        view.setIncludeFontPadding(false);
        view.setBackground(circle(Profiles.avatarColor(profile.avatar)));
        view.setLayoutParams(new LinearLayout.LayoutParams(sizePx, sizePx));
        return view;
    }

    static GradientDrawable circle(int color) {
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setColor(color);
        return shape;
    }

    /** Shows the picker; {@code backReturns} is false on a cold start or after a long screen-off. */
    static Dialog show(Activity activity, boolean backReturns, Listener listener) {
        float density = activity.getResources().getDisplayMetrics().density;
        List<Profiles.Profile> roster = Profiles.load(activity);
        String activeId = ProfileSession.activeId(activity);

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xF20B0F17);

        TextView title = new TextView(activity);
        title.setText(R.string.profile_picker_title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        title.setGravity(Gravity.CENTER);
        root.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        if (activity.getResources().getBoolean(R.bool.rtl_menu_bar)) row.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        rowLp.topMargin = (int) (40 * density);
        root.addView(row, rowLp);

        final Dialog dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
        dialog.setContentView(root);
        dialog.setCancelable(backReturns);
        dialog.setCanceledOnTouchOutside(false);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        }

        int avatarPx = (int) (96 * density);
        View focus = null;
        for (Profiles.Profile profile : roster) {
            View tile = tile(activity, density, avatar(activity, profile, avatarPx), displayName(activity, profile));
            tile.setOnClickListener(v -> {
                dialog.dismiss();
                listener.onPicked(profile);
            });
            row.addView(tile);
            if (focus == null || profile.id.equals(activeId)) focus = tile;   // the last active, else the first
        }
        if (Profiles.canAdd(roster)) {
            TextView plus = new TextView(activity);
            plus.setText("+");
            plus.setTextColor(Color.WHITE);
            plus.setTextSize(TypedValue.COMPLEX_UNIT_PX, avatarPx * 0.5f);
            plus.setGravity(Gravity.CENTER);
            plus.setIncludeFontPadding(false);
            plus.setBackground(circle(0xFF374151));
            plus.setLayoutParams(new LinearLayout.LayoutParams(avatarPx, avatarPx));
            View add = tile(activity, density, plus, activity.getString(R.string.profile_add));
            add.setOnClickListener(v -> {
                dialog.dismiss();
                listener.onAdd();
            });
            row.addView(add);
        }
        ImageView gear = new ImageView(activity);
        gear.setImageResource(R.drawable.ic_settings);
        gear.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        int inset = (int) (28 * density);
        gear.setPadding(inset, inset, inset, inset);
        gear.setBackground(circle(0xFF374151));
        gear.setLayoutParams(new LinearLayout.LayoutParams(avatarPx, avatarPx));
        View manage = tile(activity, density, gear, activity.getString(R.string.profile_manage));
        manage.setOnClickListener(v -> {
            dialog.dismiss();
            listener.onManage();
        });
        row.addView(manage);

        dialog.show();
        if (focus != null) focus.requestFocus();
        return dialog;
    }

    /** One focusable tile: the circle over the name, lit and a little larger while focused. */
    private static View tile(Context ctx, float density, View circle, String label) {
        LinearLayout tile = new LinearLayout(ctx);
        tile.setOrientation(LinearLayout.VERTICAL);
        tile.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = (int) (14 * density);
        tile.setPadding(pad, pad, pad, pad);
        tile.setFocusable(true);
        tile.setClickable(true);
        GradientDrawable lit = new GradientDrawable();
        lit.setCornerRadius(18 * density);
        lit.setColor(0x33FFFFFF);
        lit.setStroke((int) (2 * density), Color.WHITE);
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_focused}, lit);
        states.addState(new int[]{}, new ColorDrawable(Color.TRANSPARENT));
        tile.setBackground(states);
        tile.setOnFocusChangeListener((v, has) -> v.animate().scaleX(has ? 1.08f : 1f).scaleY(has ? 1.08f : 1f)
                .setDuration(120).start());
        tile.addView(circle);
        TextView name = new TextView(ctx);
        name.setText(label);
        name.setTextColor(Color.WHITE);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        name.setGravity(Gravity.CENTER);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        name.setMaxWidth((int) (130 * density));
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        nameLp.topMargin = (int) (12 * density);
        tile.addView(name, nameLp);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        int gap = (int) (10 * density);
        lp.setMargins(gap, 0, gap, 0);
        tile.setLayoutParams(lp);
        return tile;
    }
}
