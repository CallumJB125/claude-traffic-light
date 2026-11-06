import Foundation
import Darwin
import KeeperSupport
import SwiftTerm

#if KEEPER_DEV
let development = true
#else
let development = false
#endif
let build = 1
let team = Bundle.main.object(forInfoDictionaryKey: "PlexiformTeamID") as? String ?? ""
var sessionHome = NSHomeDirectory()
let maxFrame = 65536, maxRing = 1024 * 1024
func json(_ value: Any) -> Data { (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data() }
func frame(_ type: UInt8, _ payload: Data) -> Data {
    var n = UInt32(payload.count + 1).bigEndian
    var out = withUnsafeBytes(of: &n) { Data($0) }; out.append(type); out.append(payload); return out
}
func dataFrame(_ channel: UInt32, _ bytes: Data) -> Data {
    var c = channel.bigEndian; var payload = withUnsafeBytes(of: &c) { Data($0) }; payload.append(bytes); return frame(2, payload)
}
func u32(_ data: Data, _ at: Int = 0) -> UInt32 { data[at..<at+4].reduce(0) { ($0 << 8) | UInt32($1) } }
func safeString(_ x: Any?, _ limit: Int) -> String? { guard let s = x as? String, !s.contains("\0"), s.utf8.count <= limit else { return nil }; return s }
func dimension(_ x: Any?, _ max: Int) -> Int? { guard let n = x as? Int, n > 0, n <= max else { return nil }; return n }

final class Peer {
    let fd: Int32, role: String
    var input = Data(), output = Data(), channels: [UInt32: String] = [:], hello = false
    var readSource: DispatchSourceRead?, writeSource: DispatchSourceWrite?
    init(_ fd: Int32, _ role: String) { self.fd = fd; self.role = role }
    func send(_ value: [String: Any]) { sendBytes(frame(1, json(value))) }
    func sendBytes(_ data: Data) {
        guard peers[fd] != nil else { return }
        if output.count + data.count > 8 * 1024 * 1024 { closePeer(fd); return }
        output.append(data); drain()
    }
    func drain() {
        while !output.isEmpty {
            let n = output.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, output.count) }
            if n > 0 { output.removeFirst(n) }
            else if errno == EAGAIN || errno == EWOULDBLOCK {
                if writeSource == nil { let s = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: .main); s.setEventHandler { [weak self] in self?.drain() }; writeSource = s; s.resume() }
                return
            } else { closePeer(fd); return }
        }
        writeSource?.cancel(); writeSource = nil
    }
    func reply(_ id: Int, _ fields: [String: Any] = [:]) { var out: [String: Any] = ["v": 1, "re": id, "ok": true, "code": NSNull(), "text": ""]; out.merge(fields) { _, b in b }; send(out) }
    func fail(_ id: Int, _ code: String, _ text: String) { send(["v": 1, "re": id, "ok": false, "code": code, "text": text]) }
}

final class Session: TerminalDelegate {
    let id = UUID().uuidString.lowercased(), kind: String, cwd: String
    let startedAt = ISO8601DateFormatter().string(from: Date())
    var pid: Int32 = -1, master: Int32 = -1, tty = "", exitInfo: Any = NSNull(), outputBytes = 0
    var state = "running", ring = Data(), input = Data(), channel: UInt32 = 0, owner: Int32? = nil
    var source: DispatchSourceRead?, writer: DispatchSourceWrite?, terminal: Terminal!
    init(_ kind: String, _ cwd: String, _ cols: Int, _ rows: Int) {
        self.kind = kind; self.cwd = cwd
        terminal = Terminal(delegate: self, options: TerminalOptions(cols: cols, rows: rows, scrollback: 0))
    }
    func metadata() -> [String: Any] {
        ["sessionId": id, "kind": kind, "origin": ["by": "terminal", "taskId": NSNull()], "provider": kind == "shell" ? NSNull() : kind as Any,
         "providerSessionId": NSNull(), "cwd": cwd, "tty": tty, "pid": pid, "startedAt": startedAt, "state": state, "exit": exitInfo, "outputBytes": outputBytes]
    }
    func send(source: Terminal, data: ArraySlice<UInt8>) {
        // One responder, also during detach/replay. Never report a program-set
        // title, clipboard or screen contents back to the child.
        let d = Data(data)
        if d.count >= 3, d[0] == 27, d[1] == 91, [99, 110, 82].contains(d.last!), d.dropFirst(2).dropLast().allSatisfy({ (48...57).contains($0) || [59, 63, 62].contains($0) }) { enqueue(d) }
    }
    func isProcessTrusted(source: Terminal) -> Bool { false }
    func windowCommand(source: Terminal, command: Terminal.WindowManipulationCommand) -> [UInt8]? { nil }
    func enqueue(_ d: Data) {
        guard state == "running", input.count + d.count <= 256 * 1024 else { return }
        input.append(d); drain()
    }
    func drain() {
        while !input.isEmpty {
            let n = input.withUnsafeBytes { Darwin.write(master, $0.baseAddress!, input.count) }
            if n > 0 { input.removeFirst(n) }
            else if errno == EAGAIN || errno == EWOULDBLOCK {
                if writer == nil { let s = DispatchSource.makeWriteSource(fileDescriptor: master, queue: .main); s.setEventHandler { [weak self] in self?.drain() }; writer = s; s.resume() }; return
            } else { return }
        }
        writer?.cancel(); writer = nil
    }
    func resize(_ cols: Int, _ rows: Int) {
        terminal.resize(cols: cols, rows: rows)
        var size = winsize(ws_row: UInt16(rows), ws_col: UInt16(cols), ws_xpixel: 0, ws_ypixel: 0)
        if state == "running" { _ = ioctl(master, TIOCSWINSZ, &size) }
    }
    func readOutput() {
        var buf = [UInt8](repeating: 0, count: 16384)
        // Yield after a bounded read budget so a flood cannot starve input.
        for _ in 0..<16 {
            let n = Darwin.read(master, &buf, buf.count)
            if n <= 0 { if n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) { source?.cancel(); source = nil }; return }
            let d = Data(buf.prefix(n)); outputBytes += n
            ring.append(d); if ring.count > maxRing { ring.removeFirst(ring.count - maxRing) }
            terminal.feed(byteArray: Array(d))
            if let owner, let p = peers[owner] { p.sendBytes(dataFrame(channel, d)) }
        }
    }
    func snapshot() -> Data {
        // Current screen from the bounded headless model, with cell colours and
        // cursor position. Raw history never persists to disk.
        var text = "\u{1b}[0m\u{1b}[?1049l\u{1b}[r\u{1b}[2J\u{1b}[H"
        if terminal.isCurrentBufferAlternate { text += "\u{1b}[?1049h" }
        var previous: Attribute? = nil
        func color(_ c: Attribute.Color, _ background: Bool) -> String {
            let base = background ? 48 : 38
            switch c {
            case .ansi256(let n): return "\(base);5;\(n)"
            case .trueColor(let r, let g, let b): return "\(base);2;\(r);\(g);\(b)"
            default: return background ? "49" : "39"
            }
        }
        for row in 0..<terminal.rows {
            text += "\u{1b}[\(row+1);1H"
            for col in 0..<terminal.cols {
                guard let cell = terminal.getCharData(col: col, row: row), cell.width != 0 else { continue }
                if previous != cell.attribute {
                    let a = cell.attribute; var codes = ["0", color(a.fg, false), color(a.bg, true)]
                    for (style, code) in [(CharacterStyle.bold, "1"), (.dim, "2"), (.italic, "3"), (.underline, "4"), (.blink, "5"), (.inverse, "7"), (.invisible, "8"), (.crossedOut, "9")] { if a.style.contains(style) { codes.append(code) } }
                    text += "\u{1b}[\(codes.joined(separator: ";"))m"; previous = a
                }
                let c = terminal.getCharacter(for: cell); text += c == "\0" ? " " : String(c)
            }
        }
        let cursor = terminal.getCursorLocation()
        text += "\u{1b}[\(terminal.buffer.scrollTop+1);\(terminal.buffer.scrollBottom+1)r"
        let current = terminal.currentAttribute
        var currentCodes = ["0", color(current.fg, false), color(current.bg, true)]
        for (style, code) in [(CharacterStyle.bold, "1"), (.dim, "2"), (.italic, "3"), (.underline, "4"), (.blink, "5"), (.inverse, "7"), (.invisible, "8"), (.crossedOut, "9")] { if current.style.contains(style) { currentCodes.append(code) } }
        text += "\u{1b}[\(currentCodes.joined(separator: ";"))m\u{1b}[\(cursor.y+1);\(cursor.x+1)H"
        text += terminal.applicationCursor ? "\u{1b}[?1h" : "\u{1b}[?1l"
        text += terminal.bracketedPasteMode ? "\u{1b}[?2004h" : "\u{1b}[?2004l"
        return Data(text.utf8)
    }
}
var peers: [Int32: Peer] = [:], sessions: [String: Session] = [:], publishedRows: [[String: Any]] = []
var nextChannel: UInt32 = 0, refusedPeers = 0, lastActivity = Date(), spawnTimes: [Date] = []
func broadcast(_ value: [String: Any]) { for p in Array(peers.values) where p.hello && p.role == "driver" { p.send(value) } }
func closePeer(_ fd: Int32) {
    guard let p = peers.removeValue(forKey: fd) else { return }
    p.readSource?.cancel(); p.writeSource?.cancel(); Darwin.close(fd)
    for s in sessions.values where s.owner == fd { s.owner = nil; s.channel = 0 }
    lastActivity = Date()
}
func strings(_ values: [String]) -> [UnsafeMutablePointer<CChar>?] { values.map { strdup($0) } + [nil] }
func spawn(_ p: Peer, _ m: [String: Any], _ request: Int) {
    guard p.role == "driver" else { p.fail(request, "ROLE", "Takeover control is not enabled in this development preview."); return }
    guard let kind = m["kind"] as? String, ["shell", "claude", "codex"].contains(kind), let cwd = safeString(m["cwd"], 1024), cwd.hasPrefix("/"),
          let argv = m["argv"] as? [String], let exe = argv.first, exe.hasPrefix("/"), argv.count <= 2,
          let cols = dimension(m["cols"], 400), let rows = dimension(m["rows"], 200), (m["env"] as? [String: String])?.isEmpty == true else { p.fail(request, "VALIDATION", "Invalid terminal launch."); return }
    var st = stat(); guard stat(cwd, &st) == 0, st.st_mode & S_IFMT == S_IFDIR else { p.fail(request, "SPAWN_REFUSED", "Project folder is unavailable."); return }
    guard pf_locked() == 0 else { p.fail(request, "TERMINAL_DIDNT_START", "The Mac session must be active and unlocked."); return }
    let requirements = ["claude": "identifier \"com.anthropic.claude-code\" and anchor apple generic and certificate leaf[subject.OU] = \"Q6L2SF6YDW\"", "codex": "identifier \"codex\" and anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\""]
    if kind == "shell" {
        guard ["/bin/zsh", "/bin/bash", "/bin/sh"].contains(exe), argv == [exe, "-l"], pf_verify_executable(exe, "anchor apple") == 1 else { p.fail(request, "SPAWN_REFUSED", "Only an Apple-signed login shell may start."); return }
    } else {
        guard argv == [exe], pf_verify_executable(exe, requirements[kind]!) == 1 else { p.fail(request, "SPAWN_REFUSED", "The provider executable signature did not match."); return }
    }
    spawnTimes.removeAll { Date().timeIntervalSince($0) > 60 }
    guard sessions.count < 64, spawnTimes.count < 10 else { p.fail(request, "LIMIT", "Close an ended tab or wait before starting another."); return }
    // Native starts arrive only from the driver after its visible window is focused.
    let s = Session(kind, cwd, cols, rows)
    let env = ["HOME": sessionHome, "USER": NSUserName(), "LOGNAME": NSUserName(), "SHELL": "/bin/zsh", "TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "PlexiformTerminal", "LANG": "en_US.UTF-8", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(NSHomeDirectory())/.local/bin", "TMPDIR": NSTemporaryDirectory()]
    var av = strings(argv), ev = strings(env.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }), tty = [CChar](repeating: 0, count: 1024)
    defer { for v in av { free(v) }; for v in ev { free(v) } }
    s.pid = pf_spawn(exe, &av, &ev, cwd, UInt16(cols), UInt16(rows), &s.master, &tty)
    guard s.pid > 0 else { p.fail(request, "SPAWN_REFUSED", "The terminal process could not start."); return }
    s.tty = String(cString: tty); _ = fcntl(s.master, F_SETFL, O_NONBLOCK); _ = fcntl(s.master, F_SETFD, FD_CLOEXEC)
    let source = DispatchSource.makeReadSource(fileDescriptor: s.master, queue: .main); source.setEventHandler { [weak s] in s?.readOutput() }; s.source = source
    sessions[s.id] = s; spawnTimes.append(Date()); source.resume(); p.reply(request, ["sessionId": s.id, "tty": s.tty]); broadcast(["v": 1, "ev": "session.added", "session": s.metadata()])
}
func message(_ p: Peer, _ m: [String: Any]) {
    guard m["v"] as? Int == 1, let id = m["id"] as? Int, id > 0, let op = m["op"] as? String else { closePeer(p.fd); return }
    if !p.hello {
        guard op == "hello", m["app"] as? String == (p.role == "driver" ? "terminal" : "plexiform"), m["minor"] as? Int == 0 else { closePeer(p.fd); return }
        p.hello = true; p.reply(id, ["welcome": ["minor": 0, "keeper": ["version": "0.1.0", "build": build], "role": p.role, "caps": ["native-tabs", "bounded-screen", "development-preview"]]]); return
    }
    switch op {
    case "status": p.reply(id, ["status": ["keeper": ["version": "0.1.0", "build": build], "protocol": ["major": 1, "minor": 0], "sessions": sessions.count, "drivers": peers.values.filter { $0.role == "driver" }.count, "refusedPeers": refusedPeers, "restarts": ["lastHour": 0, "total": 0]]])
    case "list": p.reply(id, ["sessions": p.role == "driver" ? sessions.values.map { $0.metadata() }.sorted { ($0["startedAt"] as! String) < ($1["startedAt"] as! String) } : []])
    case "spawn": spawn(p, m, id)
    case "attach":
        guard p.role == "driver" else { p.fail(id, "ROLE", "Control peers cannot attach."); return }
        guard let key = m["sessionId"] as? String, let s = sessions[key], let cols = dimension(m["cols"], 400), let rows = dimension(m["rows"], 200) else { p.fail(id, "NOT_FOUND", "Terminal is unavailable."); return }
        if let owner = s.owner, owner != p.fd { p.fail(id, "LIMIT", "This terminal is attached to another window."); return }
        for (channel, key) in Array(p.channels) { if sessions[key]?.owner == p.fd { sessions[key]?.owner = nil }; p.channels.removeValue(forKey: channel) }
        nextChannel += 1; s.channel = nextChannel; s.owner = p.fd; p.channels[nextChannel] = key; s.resize(cols, rows)
        p.reply(id, ["channel": nextChannel])
        let snapshot = s.snapshot(); for start in stride(from: 0, to: snapshot.count, by: 60000) { p.sendBytes(dataFrame(nextChannel, snapshot.subdata(in: start..<min(start+60000, snapshot.count)))) }
        p.send(["v": 1, "ev": "handoff", "channel": nextChannel])
    case "resize", "detach", "handoff":
        guard p.role == "driver", let ch = m["channel"] as? UInt32, let key = p.channels[ch], let s = sessions[key], s.owner == p.fd else { p.fail(id, "ROLE", "No owned terminal channel."); return }
        if op == "resize" { guard let cols = dimension(m["cols"], 400), let rows = dimension(m["rows"], 200) else { p.fail(id, "VALIDATION", "Invalid terminal size."); return }; s.resize(cols, rows) }
        if op == "detach" { s.owner = nil; p.channels.removeValue(forKey: ch) }; p.reply(id)
    case "signal":
        guard p.role == "driver", let key = m["sessionId"] as? String, let s = sessions[key], m["signal"] as? String == "HUP" else { p.fail(id, "ROLE", "Only an explicit terminal close is supported."); return }
        if s.state == "running" { kill(-s.pid, SIGHUP); kill(s.pid, SIGHUP) } else { sessions.removeValue(forKey: key) }; p.reply(id)
    case "shutdown":
        guard p.role == "driver", sessions.values.allSatisfy({ $0.state != "running" }) else { p.fail(id, "ROLE", "Live terminals keep the keeper running."); return }; p.reply(id); DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) }
    case "rows.publish":
        guard p.role == "control", let rows = m["rows"] as? [[String: Any]], rows.count <= 200 else { p.fail(id, "ROLE", "Only Plexiform may publish structured rows."); return }
        // Preview has no publisher integration yet. Reject instead of implying that private sessions are wired.
        p.fail(id, "UNKNOWN_OP", "Agent row publishing is not enabled in this development preview.")
    default: p.fail(id, "UNKNOWN_OP", "This operation is not enabled in this development preview.")
    }
}
func readPeer(_ p: Peer) {
    var buf = [UInt8](repeating: 0, count: 16384)
    let n = Darwin.read(p.fd, &buf, buf.count)
    if n <= 0 { if n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) { closePeer(p.fd) }; return }
    p.input.append(contentsOf: buf.prefix(n))
    while p.input.count >= 4 {
        let count = Int(u32(p.input)); guard count >= 1, count <= maxFrame else { closePeer(p.fd); return }
        if p.input.count < count + 4 { return }
        let type = p.input[4], payload = p.input.subdata(in: 5..<count+4); p.input = Data(p.input.dropFirst(count+4))
        if type == 1 { guard let m = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else { closePeer(p.fd); return }; message(p, m) }
        else if type == 2, p.hello, p.role == "driver", payload.count >= 4 {
            let ch = u32(payload); guard let key = p.channels[ch], let s = sessions[key], s.owner == p.fd else { closePeer(p.fd); return }; s.enqueue(payload.dropFirst(4))
        } else { closePeer(p.fd); return }
        if peers[p.fd] == nil { return }
    }
}
if CommandLine.arguments.contains("--build-info") { print(String(data: json(["build": build, "dev": development, "team": team, "protocolMajor": 1]), encoding: .utf8)!); exit(0) }
guard development || !team.isEmpty else { fputs("Keeper is dormant: Developer ID signing is required.\n", stderr); exit(78) }
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--test-home"), i+1 < args.count {
    guard development else { exit(64) }
    let home = args[i+1]
    var homeStat = stat()
    guard home.hasPrefix("/private/tmp/"), lstat(home, &homeStat) == 0, homeStat.st_uid == getuid(), homeStat.st_mode & S_IFMT == S_IFDIR, homeStat.st_mode & 0o077 == 0 else { exit(77) }
    sessionHome = home
}
let defaultFolder = NSHomeDirectory() + "/Library/Application Support/Plexiform/Keeper/sockets"
var socketPath = defaultFolder + "/k1-b1.sock"
if let i = args.firstIndex(of: "--socket"), i+1 < args.count {
    guard development else { exit(64) }; socketPath = args[i+1]
}
guard socketPath.utf8.count < 100, socketPath.hasPrefix("/"), !socketPath.contains("\0") else { fputs("Invalid socket path.\n", stderr); exit(64) }
let folder = (socketPath as NSString).deletingLastPathComponent
try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
var st = stat(); guard lstat(folder, &st) == 0, st.st_uid == getuid(), st.st_mode & S_IFMT == S_IFDIR, st.st_mode & 0o077 == 0 else { fputs("Socket folder must be private and owned by this user.\n", stderr); exit(77) }
let lockFD = open(socketPath + ".lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { exit(73) }
if lstat(socketPath, &st) == 0 { guard st.st_uid == getuid(), st.st_mode & S_IFMT == S_IFSOCK else { exit(77) }; unlink(socketPath) }
let server = socket(AF_UNIX, SOCK_STREAM, 0); guard server >= 0 else { exit(71) }
_ = fcntl(server, F_SETFL, O_NONBLOCK); _ = fcntl(server, F_SETFD, FD_CLOEXEC)
var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
withUnsafeMutableBytes(of: &address.sun_path) { b in b.copyBytes(from: Array(socketPath.utf8) + [0]) }
let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
guard bound == 0, chmod(socketPath, 0o600) == 0, listen(server, 8) == 0 else { exit(71) }
let acceptSource = DispatchSource.makeReadSource(fileDescriptor: server, queue: .main)
acceptSource.setEventHandler {
    for _ in 0..<8 {
        let fd = accept(server, nil, nil); if fd < 0 { return }
        _ = fcntl(fd, F_SETFL, O_NONBLOCK); _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        var identifier = [CChar](repeating: 0, count: 256), peerBuild: Int32 = 0
        guard pf_peer(fd, development ? 1 : 0, team, &identifier, 256, &peerBuild) == 1 else { refusedPeers += 1; close(fd); continue }
        let ident = String(cString: identifier), role = ident == "dev.plexiform.terminal" ? "driver" : ident == "dev.plexiform.app" ? "control" : ""
        guard !role.isEmpty, development || peerBuild >= 1, peers.values.filter({ $0.role == role }).count < 4 else { refusedPeers += 1; close(fd); continue }
        let p = Peer(fd, role); peers[fd] = p
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main); source.setEventHandler { [weak p] in if let p { readPeer(p) } }; p.readSource = source; source.resume()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak p] in if let p, !p.hello { closePeer(p.fd) } }
    }
}
acceptSource.resume()
let timer = DispatchSource.makeTimerSource(queue: .main); timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
timer.setEventHandler {
    for s in sessions.values where s.state == "running" {
        var status: Int32 = 0
        if waitpid(s.pid, &status, WNOHANG) == s.pid {
            s.readOutput(); s.state = "exited"; s.exitInfo = ["code": Int((status >> 8) & 255), "signal": Int(status & 127)]
            s.source?.cancel(); s.source = nil; s.writer?.cancel(); s.writer = nil; close(s.master)
            broadcast(["v": 1, "ev": "session.exited", "sessionId": s.id, "code": Int((status >> 8) & 255), "signal": Int(status & 127)])
            lastActivity = Date()
        }
    }
    if peers.isEmpty && sessions.values.allSatisfy({ $0.state != "running" }) && Date().timeIntervalSince(lastActivity) > 600 { unlink(socketPath); exit(0) }
}
timer.resume()
signal(SIGPIPE, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM, SIGHUP] {
    signal(sig, SIG_IGN); let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { for s in sessions.values where s.state == "running" { kill(-s.pid, SIGHUP); kill(s.pid, SIGHUP) }; unlink(socketPath); exit(0) }; source.resume(); signalSources.append(source)
}
dispatchMain()
