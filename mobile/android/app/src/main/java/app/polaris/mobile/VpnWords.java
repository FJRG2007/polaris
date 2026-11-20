package app.polaris.mobile;

import android.content.Context;

/** What went wrong with the VPN, in the reader's words, from the code the tunnel or Polaris gave. */
final class VpnWords {
    private VpnWords() {
    }

    static String of(Context context, String code) {
        switch (code) {
            case VpnTunnel.DENIED:
                return context.getString(R.string.vpn_error_denied);
            case VpnTunnel.NO_ANSWER:
                return context.getString(R.string.vpn_error_no_answer);
            case VpnTunnel.UNREACHABLE:
                return context.getString(R.string.vpn_error_unreachable);
            case VpnTunnel.SIGN_IN:
                return context.getString(R.string.vpn_error_sign_in);
            case VpnTunnel.NO_PLACE:
                return context.getString(R.string.vpn_error_no_place);
            case VpnTunnel.NO_ACCESS:
                return context.getString(R.string.vpn_error_no_access);
            case "deviceLimit":
                return context.getString(R.string.vpn_error_device_limit);
            case "nodeFull":
                return context.getString(R.string.vpn_error_node_full);
            case "nodeNotReady":
            case "notFound":
                return context.getString(R.string.vpn_error_node_gone);
            default:
                return context.getString(R.string.vpn_error_failed);
        }
    }
}
