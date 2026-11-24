#import <AppKit/AppKit.h>

#import "services.h"

@implementation RookServicesProvider

// Opens a new tab for each file URL in the pasteboard, with the initial
// directory set to the provided path (or parent directory, if the path
// is to a file).
//
// This is registered as a service endpoint in the embedded Info.plist.
- (void)openTab:(NSPasteboard *)pboard userData:(NSString *)userData error:(NSString **)error {
    [self forFilesFromPasteboard:pboard performAction:@"/new_tab"];
}

// Opens a new window for each file URL in the pasteboard, with the initial
// directory set to the provided path (or parent directory, if the path
// is to a file).
//
// This is registered as a service endpoint in the embedded Info.plist.
- (void)openWindow:(NSPasteboard *)pboard userData:(NSString *)userData error:(NSString **)error {
    [self forFilesFromPasteboard:pboard performAction:@"/new_window"];
}

// Parses file URLs from the provided pasteboard and makes an intent into
// the application to perform the provided action for each path.
- (void)forFilesFromPasteboard:(NSPasteboard *)pboard performAction:(NSString *)action {
    @autoreleasepool {
        NSArray<NSURL *> *urls = [pboard readObjectsForClasses:@[ [NSURL class] ] options:0];
        NSMutableArray<NSString *> *filePaths = [NSMutableArray array];
        for (NSURL *url in urls) {
            [filePaths addObject:url.path];
        }

        NSMutableArray<NSURL *> *rookUrls = [NSMutableArray array];
        for (NSString *path in filePaths) {
            NSURLComponents *components = [[[NSURLComponents alloc] init] autorelease];
            NSString *scheme = rook_services_provider_custom_url_scheme();
            [components setScheme:scheme];
            [components setHost:@"action"];
            [components setPath:action];
            NSMutableArray *queryItems = [NSMutableArray array];
            [queryItems addObject:[NSURLQueryItem queryItemWithName:@"path" value:path]];
            [components setQueryItems:queryItems];
            [rookUrls addObject:components.URL];
        };

        NSApplication *app = [NSApplication sharedApplication];
        rook_app_open_urls(app, rookUrls);
    }
}

@end

// Creates a new RookServicesProvider and registers it as the global services
// provider for the application
void rook_register_services_provider() {
    RookServicesProvider *provider = [[RookServicesProvider alloc] init];

    // Set the global NSServices provider for the application.  This holds a
    // strong reference to the provider, so we don't have to worry about it
    // being prematurely cleaned up while the application exist.
    [NSApp setServicesProvider:provider];
    [provider release];
}
