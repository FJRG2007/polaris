package polaris.anticheat.api.event;

@FunctionalInterface
public interface PolarisEventListener<T extends PolarisEvent<?>> {
    void handle(T event) throws Exception;
}