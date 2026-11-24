// Our class for handling NSServices messages.
@interface RookServicesProvider : NSObject
@end

// Functions implemented in Rust.
id rook_services_provider_custom_url_scheme();
void rook_app_open_urls(id app, id urls);
