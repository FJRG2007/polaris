import Photos
import UIKit
import UniformTypeIdentifiers

/// The phone's photos and videos for chat's "+" sheet, the way Discord and Signal show the recent ones inline
/// (`lib/mobile-media.ts` on the page). Newest first, a page at a time; previews are small JPEGs made on demand, and a
/// file crosses the bridge in chunks so a long video is never one string.
///
/// Limited access is the normal case on iOS: the grid shows the photos the person chose, and "manage" opens the
/// system's own "Select More Photos". The automatic limited-access alert is off in Info.plist, so it only appears
/// when the person asks for it here.
final class DeviceMedia {
    private weak var presenter: UIViewController?
    private let answer: (String, [String: Any]) -> Void
    private let thumbs = PHCachingImageManager()
    private let queue = DispatchQueue(label: "app.polaris.media", qos: .userInitiated)
    /// The newest-first library, kept between pages so the next page continues the same list.
    private var library: PHFetchResult<PHAsset>?
    /// The one file being handed over, written to disk once and read from there a chunk at a time.
    private var prepared: (id: String, url: URL)?

    private static let chunk = 512 * 1024
    private static let thumbSide: CGFloat = 320
    private static let maxPage = 200

    init(presenter: UIViewController, answer: @escaping (String, [String: Any]) -> Void) {
        self.presenter = presenter
        self.answer = answer
    }

    deinit { if let prepared { try? FileManager.default.removeItem(at: prepared.url) } }

    /// One call from the page. Runs on the main thread; every answer goes back on it too.
    func call(id: String, op: String, args: [String: Any]) {
        switch op {
        case "access":
            answer(id, ["access": Self.access()])
        case "request":
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] _ in
                DispatchQueue.main.async {
                    self?.library = nil
                    self?.answer(id, ["access": Self.access()])
                }
            }
        case "manage":
            guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited, let presenter else {
                return call(id: id, op: "request", args: args)
            }
            PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter) { [weak self] _ in
                DispatchQueue.main.async {
                    self?.library = nil
                    self?.answer(id, ["access": Self.access()])
                }
            }
        case "settings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            answer(id, [:])
        case "list":
            guard Self.readable() else { return answer(id, ["error": "denied"]) }
            let offset = max(0, args["offset"] as? Int ?? 0)
            let limit = min(Self.maxPage, max(1, args["limit"] as? Int ?? 48))
            answer(id, list(offset: offset, limit: limit))
        case "thumb":
            guard Self.readable(), let asset = Self.asset(args["id"]) else { return answer(id, ["error": "invalid"]) }
            thumb(asset) { [weak self] result in self?.answer(id, result) }
        case "read":
            guard Self.readable(), let asset = Self.asset(args["id"]) else { return answer(id, ["error": "invalid"]) }
            let offset = max(0, args["offset"] as? Int ?? 0)
            read(asset, from: offset) { [weak self] result in self?.answer(id, result) }
        default:
            answer(id, ["error": "unknown"])
        }
    }

    /// "full", "limited", "prompt" before iOS has asked, "denied" once only Settings can change it.
    static func access() -> String {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return "full"
        case .limited: return "limited"
        case .notDetermined: return "prompt"
        default: return "denied"
        }
    }

    private static func readable() -> Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return status == .authorized || status == .limited
    }

    private static func asset(_ raw: Any?) -> PHAsset? {
        guard let id = raw as? String, !id.isEmpty, id.count <= 512 else { return nil }
        return PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
    }

    private func list(offset: Int, limit: Int) -> [String: Any] {
        if offset == 0 || library == nil {
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.predicate = NSPredicate(
                format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue
            )
            library = PHAsset.fetchAssets(with: options)
        }
        guard let library, offset < library.count else { return ["items": [], "more": false] }
        let end = min(library.count, offset + limit)
        var items: [[String: Any]] = []
        for index in offset..<end {
            let asset = library.object(at: index)
            let video = asset.mediaType == .video
            let (name, mime) = Self.described(asset)
            items.append([
                "id": asset.localIdentifier,
                "video": video,
                "duration": video ? Int(asset.duration * 1000) : 0,
                "name": name,
                "mime": mime,
                // iOS documents no size for an asset before its data is read; the page checks it once read.
                "size": 0
            ])
        }
        return ["items": items, "more": end < library.count]
    }

    /// The name and type the page sends it as. A HEIC photo goes as a JPEG, which every screen can show.
    private static func described(_ asset: PHAsset) -> (String, String) {
        let video = asset.mediaType == .video
        let resource = PHAssetResource.assetResources(for: asset).first { $0.type == (video ? .video : .photo) }
        let type = resource.flatMap { UTType($0.uniformTypeIdentifier) }
        var name = resource?.originalFilename ?? (video ? "video.mov" : "photo.jpg")
        if !video, type.map(Self.isHeic) ?? false {
            name = (name as NSString).deletingPathExtension + ".jpg"
            return (name, "image/jpeg")
        }
        return (name, type?.preferredMIMEType ?? (video ? "video/quicktime" : "image/jpeg"))
    }

    private static func isHeic(_ type: UTType) -> Bool {
        type.conforms(to: .heic) || type.conforms(to: .heif)
    }

    private func thumb(_ asset: PHAsset, done: @escaping ([String: Any]) -> Void) {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let side = Self.thumbSide
        thumbs.requestImage(for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill,
                            options: options) { [queue] image, _ in
            // Encoded off the main thread; answered back on it.
            queue.async {
                let data = image?.jpegData(compressionQuality: 0.75)
                DispatchQueue.main.async {
                    guard let data else { return done(["error": "failed"]) }
                    done(["src": "data:image/jpeg;base64," + data.base64EncodedString()])
                }
            }
        }
    }

    private func read(_ asset: PHAsset, from offset: Int, done: @escaping ([String: Any]) -> Void) {
        let id = asset.localIdentifier
        if let prepared, prepared.id == id { return chunk(prepared.url, id: id, from: offset, done: done) }
        prepare(asset) { [weak self] url in
            guard let self, let url else { return done(["error": "failed"]) }
            if let old = self.prepared { try? FileManager.default.removeItem(at: old.url) }
            self.prepared = (id, url)
            self.chunk(url, id: id, from: offset, done: done)
        }
    }

    /// The photo or video written to a file of its own, downloaded from iCloud first when it lives only there.
    private func prepare(_ asset: PHAsset, done: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("polaris-media", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(UUID().uuidString)
        if asset.mediaType == .video {
            let resources = PHAssetResource.assetResources(for: asset)
            guard let resource = resources.first(where: { $0.type == .fullSizeVideo })
                ?? resources.first(where: { $0.type == .video }) else { return done(nil) }
            let options = PHAssetResourceRequestOptions()
            options.isNetworkAccessAllowed = true
            PHAssetResourceManager.default().writeData(for: resource, toFile: target, options: options) { error in
                DispatchQueue.main.async { done(error == nil ? target : nil) }
            }
            return
        }
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.version = .current
        options.deliveryMode = .highQualityFormat
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { [queue] data, uti, _, _ in
            guard let data else { return DispatchQueue.main.async { done(nil) } }
            queue.async {
                var bytes = data
                if let uti, let type = UTType(uti), Self.isHeic(type),
                   let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) {
                    bytes = jpeg
                }
                let written = (try? bytes.write(to: target)) != nil
                DispatchQueue.main.async { done(written ? target : nil) }
            }
        }
    }

    private func chunk(_ url: URL, id: String, from offset: Int, done: @escaping ([String: Any]) -> Void) {
        queue.async { [weak self] in
            var result: [String: Any] = ["error": "failed"]
            var finished = false
            if let handle = try? FileHandle(forReadingFrom: url) {
                defer { try? handle.close() }
                let size = (try? handle.seekToEnd()).map { Int($0) } ?? 0
                if (try? handle.seek(toOffset: UInt64(offset))) != nil, let data = try? handle.read(upToCount: Self.chunk) {
                    let bytes = data
                    finished = offset + bytes.count >= size
                    result = ["data": bytes.base64EncodedString(), "size": size, "done": finished]
                }
            }
            DispatchQueue.main.async {
                // The last chunk read: the copy on disk has done its job.
                if finished, let self, let prepared = self.prepared, prepared.id == id {
                    try? FileManager.default.removeItem(at: prepared.url)
                    self.prepared = nil
                }
                done(result)
            }
        }
    }
}
