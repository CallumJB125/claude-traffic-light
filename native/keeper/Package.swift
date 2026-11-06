// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "PlexiformKeeper", platforms: [.macOS(.v13)],
    dependencies: [.package(url: "https://github.com/migueldeicaza/SwiftTerm.git", revision: "5c83a9d214e7354697624c11deb4e488bdcfabad")],
    targets: [
        .target(name: "KeeperSupport", path: "Support", publicHeadersPath: "include", linkerSettings: [.linkedFramework("Security"), .linkedFramework("ApplicationServices")]),
        .executableTarget(name: "PlexiformKeeper", dependencies: ["KeeperSupport", .product(name: "SwiftTerm", package: "SwiftTerm")], path: "Sources")
    ])
