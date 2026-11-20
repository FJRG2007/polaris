package app.polaris.mobile;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.app.slice.Slice;
import android.content.Context;
import android.content.Intent;
import android.content.IntentSender;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.autofill.Dataset;
import android.service.autofill.FillResponse;
import android.service.autofill.InlinePresentation;
import android.service.autofill.SaveInfo;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import android.view.inputmethod.InlineSuggestionsRequest;
import android.widget.RemoteViews;
import android.widget.inline.InlinePresentationSpec;
import androidx.annotation.RequiresApi;
import androidx.autofill.inline.UiVersions;
import androidx.autofill.inline.v1.InlineSuggestionUi;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * What the phone shows for a fill: a row in the drop-down under the box, and - on keyboards that take them (Gboard,
 * Samsung) - a chip in the keyboard's suggestion strip, built with androidx.autofill's inline UI the way Bitwarden's
 * Android app builds its own.
 */
final class AutofillViews {
    static final String EXTRA_MODE = "polaris.vault.mode";
    static final String MODE_UNLOCK = "unlock";
    static final String MODE_PICK = "pick";

    private static final AtomicInteger REQUESTS = new AtomicInteger(1);

    private AutofillViews() {
    }

    static RemoteViews row(Context context, String title, String subtitle) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.autofill_item);
        views.setTextViewText(R.id.autofill_title, title);
        if (subtitle == null || subtitle.isEmpty()) {
            views.setViewVisibility(R.id.autofill_subtitle, android.view.View.GONE);
        } else {
            views.setTextViewText(R.id.autofill_subtitle, subtitle);
        }
        return views;
    }

    /** The chip for the keyboard, or null when this phone or this keyboard takes none. */
    static InlinePresentation inline(Context context, InlineSuggestionsRequest request, int index, String title,
            String subtitle) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || request == null) return null;
        return inlineR(context, request, index, title, subtitle);
    }

    // Content.getSlice() is the documented way to hand a chip to the keyboard, yet
    // androidx.autofill (1.1.0 through 1.3.0) marks it library-restricted, so lint
    // flags the one call every autofill service makes. Scoped to this method only,
    // as Bitwarden does (InlinePresentationSpecExtensions.kt).
    @SuppressLint("RestrictedApi")
    @RequiresApi(Build.VERSION_CODES.R)
    private static InlinePresentation inlineR(Context context, InlineSuggestionsRequest request, int index,
            String title, String subtitle) {
        List<InlinePresentationSpec> specs = request.getInlinePresentationSpecs();
        if (specs.isEmpty() || index >= request.getMaxSuggestionCount()) return null;
        // The keyboard says how many chips it wants styled; any past the last spec take the last one.
        InlinePresentationSpec spec = specs.get(Math.min(index, specs.size() - 1));
        if (!UiVersions.getVersions(spec.getStyle()).contains(UiVersions.INLINE_UI_VERSION_1)) return null;
        // Long-pressing a chip says whose it is: this app's vault screen.
        PendingIntent attribution = PendingIntent.getActivity(context, 0,
                new Intent(context, VaultActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        InlineSuggestionUi.Content.Builder content = InlineSuggestionUi.newContentBuilder(attribution)
                .setTitle(title)
                .setStartIcon(Icon.createWithResource(context, R.drawable.ic_vault_key));
        if (subtitle != null && !subtitle.isEmpty()) content.setSubtitle(subtitle);
        Slice slice = content.build().getSlice();
        return new InlinePresentation(slice, spec, false);
    }

    /** One login as a dataset: its username into every username box, its password into every password box. */
    @SuppressWarnings("deprecation")
    @SuppressLint("NewApi")
    static Dataset login(Context context, AutofillParse parse, VaultItems.Login login, InlinePresentation chip) {
        String subtitle = login.username;
        Dataset.Builder builder = new Dataset.Builder(row(context, login.name, subtitle));
        if (chip != null) builder.setInlinePresentation(chip);
        boolean any = false;
        if (login.username != null) {
            for (AutofillId id : parse.usernames) {
                builder.setValue(id, AutofillValue.forText(login.username));
                any = true;
            }
        }
        if (login.password != null) {
            for (AutofillId id : parse.passwords) {
                builder.setValue(id, AutofillValue.forText(login.password));
                any = true;
            }
        }
        return any ? builder.build() : null;
    }

    /** A screen of this app that answers the system once the owner has proved who they are, or picked a login. */
    static IntentSender sender(Context context, String mode) {
        Intent intent = new Intent(context, VaultFillActivity.class).putExtra(EXTRA_MODE, mode);
        // Mutable: the system adds the screen's structure (and the keyboard's request) to it before it starts.
        int flags = PendingIntent.FLAG_CANCEL_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        return PendingIntent.getActivity(context, REQUESTS.getAndIncrement(), intent, flags).getIntentSender();
    }

    /** "Search Polaris Vault": every login, for an app or site nothing is saved for yet. */
    @SuppressWarnings("deprecation")
    @SuppressLint("NewApi")
    static Dataset search(Context context, AutofillParse parse, InlinePresentation chip) {
        Dataset.Builder builder = new Dataset.Builder(row(context, context.getString(R.string.vault_fill_search), null));
        if (chip != null) builder.setInlinePresentation(chip);
        for (AutofillId id : parse.ids()) builder.setValue(id, null);
        builder.setAuthentication(sender(context, MODE_PICK));
        return builder.build();
    }

    static SaveInfo saveInfo(AutofillParse parse) {
        if (parse.passwords.isEmpty()) return null;
        SaveInfo.Builder save = new SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_USERNAME | SaveInfo.SAVE_DATA_TYPE_PASSWORD,
                parse.passwords.toArray(new AutofillId[0]));
        if (!parse.usernames.isEmpty()) save.setOptionalIds(parse.usernames.toArray(new AutofillId[0]));
        // Most login screens never say they are done; they go away. That is when to offer the save.
        save.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE);
        return save.build();
    }

    /** The answer for an open vault: the logins for this app or site, the search entry, and the save offer. */
    static FillResponse unlocked(Context context, AutofillParse parse, List<VaultItems.Login> logins,
            InlineSuggestionsRequest inline) {
        FillResponse.Builder response = new FillResponse.Builder();
        int chips = 0;
        int max = inlineMax(inline);
        // One chip is always kept for the search entry.
        for (VaultItems.Login login : VaultItems.forCandidate(logins, parse.candidate())) {
            if (chips >= 20) break;
            InlinePresentation chip = chips < max - 1
                    ? inline(context, inline, chips, login.name, login.username) : null;
            Dataset dataset = login(context, parse, login, chip);
            if (dataset == null) continue;
            response.addDataset(dataset);
            chips++;
        }
        response.addDataset(search(context, parse,
                inline(context, inline, Math.min(chips, Math.max(0, max - 1)), context.getString(R.string.vault_fill_search), null)));
        SaveInfo save = saveInfo(parse);
        if (save != null) response.setSaveInfo(save);
        return response.build();
    }

    /** The answer for a locked vault: one entry that asks the owner to prove who they are, then fills. */
    @SuppressLint("NewApi")
    static FillResponse locked(Context context, AutofillParse parse, InlineSuggestionsRequest inline) {
        FillResponse.Builder response = new FillResponse.Builder();
        String title = context.getString(R.string.vault_fill_unlock);
        RemoteViews row = row(context, title, context.getString(R.string.vault_fill_unlock_hint));
        InlinePresentation chip = inline(context, inline, 0, title, null);
        IntentSender sender = sender(context, MODE_UNLOCK);
        if (chip != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            response.setAuthentication(parse.ids(), sender, row, chip);
        } else {
            response.setAuthentication(parse.ids(), sender, row);
        }
        SaveInfo save = saveInfo(parse);
        if (save != null) response.setSaveInfo(save);
        return response.build();
    }

    private static int inlineMax(InlineSuggestionsRequest inline) {
        if (inline == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return 0;
        return inline.getMaxSuggestionCount();
    }
}
