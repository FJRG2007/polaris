package polaris.anticheat.manager.player.features;

import polaris.anticheat.manager.player.features.types.PolarisFeature;
import polaris.anticheat.utils.anticheat.LogUtil;
import com.google.common.collect.ImmutableMap;

import java.util.regex.Pattern;

public class FeatureBuilder {

    private static final Pattern VALID = Pattern.compile("[a-zA-Z0-9_]{1,64}");
    private final ImmutableMap.Builder<String, PolarisFeature> mapBuilder = ImmutableMap.builder();

    public <T extends PolarisFeature> void register(T feature) {
        if (!VALID.matcher(feature.getName()).matches()) {
            LogUtil.error("Invalid feature name: " + feature.getName());
            return;
        }
        mapBuilder.put(feature.getName(), feature);
    }

    public ImmutableMap<String, PolarisFeature> buildMap() {
        return mapBuilder.build();
    }

}
