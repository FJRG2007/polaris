package polaris.anticheat.utils.item;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.latency.CompensatedWorld;
import com.github.retrooper.packetevents.protocol.item.ItemStack;
import com.github.retrooper.packetevents.protocol.player.InteractionHand;

public class AlwaysUseItem extends ItemBehaviour {

    public static final AlwaysUseItem INSTANCE = new AlwaysUseItem();

    @Override
    public boolean canUse(ItemStack item, CompensatedWorld world, PolarisPlayer player, InteractionHand hand) {
        return true;
    }

}
