// Our class for handling NSServices messages.
@interface PtermServicesProvider : NSObject
@end

// Functions implemented in Rust.
id pterm_services_provider_custom_url_scheme();
void pterm_app_open_urls(id app, id urls);
