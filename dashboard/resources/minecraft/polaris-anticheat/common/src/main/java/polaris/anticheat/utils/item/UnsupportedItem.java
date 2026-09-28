package polaris.anticheat.utils.item;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.latency.CompensatedWorld;
import com.github.retrooper.packetevents.protocol.item.ItemStack;
import com.github.retrooper.packetevents.protocol.player.InteractionHand;

public class UnsupportedItem extends ItemBehaviour {

    public static final UnsupportedItem INSTANCE = new UnsupportedItem();

    @Override
    public boolean canUse(ItemStack item, CompensatedWorld world, PolarisPlayer player, InteractionHand hand) {
        return false;
    }

}
