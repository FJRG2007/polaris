package polaris.anticheat.checks.impl.crash;

import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.impl.verbose.VerboseCodecs;
import polaris.anticheat.checks.type.PacketReceiveListener;
import polaris.anticheat.checks.type.PacketSendListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.inventory.inventory.MenuType;
import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.event.PacketSendEvent;
import com.github.retrooper.packetevents.manager.server.ServerVersion;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientClickWindow;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerOpenWindow;

@CheckData(name = "CrashD", stableKey = "polarisac.crash.lectern", description = "Clicking slots in lectern window")
public class CrashD extends Check implements PacketReceiveListener, PacketSendListener {
    private static final Verbose V = Verbose.of("clickType={clicktype}, button={sint}");

    private MenuType type = MenuType.UNKNOWN;
    private int lecternId = -1;

    public CrashD(PolarisPlayer player) {
        super(player);
    }

    @Override
    public boolean isApplicable() {
        return PacketEvents.getAPI().getServerManager().getVersion().isNewerThanOrEquals(ServerVersion.V_1_14);
    }

    @Override
    public void onPacketSend(final PacketSendEvent event) {
        if (event.getPacketType() == PacketType.Play.Server.OPEN_WINDOW) {
            WrapperPlayServerOpenWindow window = new WrapperPlayServerOpenWindow(event);
            this.type = MenuType.getMenuType(window.getType());
            if (type == MenuType.LECTERN) lecternId = window.getContainerId();
        }
    }

    @Override
    public void onPacketReceive(final PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.CLICK_WINDOW) {
            WrapperPlayClientClickWindow click = new WrapperPlayClientClickWindow(event);
            int clickType = VerboseCodecs.enumId(click.getWindowClickType());
            int button = click.getButton();
            int windowId = click.getWindowId();

            if (type == MenuType.LECTERN && windowId > 0 && windowId == lecternId) {
                if (flag(V.write(verbose()).uint(clickType).sint(button))) {
                    event.setCancelled(true);
                    player.onPacketCancel();
                }
            }
        }
    }
}
