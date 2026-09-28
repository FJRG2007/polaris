package polaris.anticheat.manager.tick.impl;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.manager.tick.Tickable;
import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.netty.channel.ChannelHelper;

public class ClientVersionSetter implements Tickable {
    @Override
    public void tick() {
        for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
            // channel was somehow closed without us getting a disconnect event
            if (!ChannelHelper.isOpen(player.user.getChannel())) {
                PolarisAPI.INSTANCE.getPlayerDataManager().onDisconnect(player.user);
                continue;
            }

            player.pollData();
        }
    }
}
