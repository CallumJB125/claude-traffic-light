// buddy-listen: push-to-talk speech-to-text for Claude Buddy, on device only.
//
//   buddy-listen status                 permission + on-device support, never prompts
//   buddy-listen listen [--hold-key N] [--max-ms MS] [--locale ID]
//   buddy-listen file PATH [--locale ID]   transcribe an audio file (latency checks)
//
// Speaks JSON lines on stdout: {"event":"authorizing"} (a macOS permission
// prompt is up), {"event":"ready"} (the mic is open, and only from here),
// {"event":"partial","text":…}, {"event":"final","text":…,"ms":…},
// {"event":"cancelled"} (let go before the mic opened), {"event":"error",…}.
//
// The mic is only ever open while the question is being held. `listen` stops
// on a "stop" line or EOF on stdin (the widget's long-press ending), when the
// held key (a macOS virtual keycode) comes up, or at --max-ms. The key is
// watched from launch, before any permission prompt: let go during the prompt
// and the mic never opens; if the key never reads as down within 300 ms, the
// helper gives up ("hold-unsupported") instead of recording until --max-ms.
//
// Recognition is SFSpeechRecognizer with requiresOnDeviceRecognition: if the
// locale has no on-device model it fails rather than falling back to Apple's
// servers. Microphone buffers go straight from the tap into the request and
// are never written anywhere.
import AVFoundation
import CoreGraphics
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func fail(_ error: String, code: Int32 = 2) -> Never {
  emit(["event": "error", "error": error])
  exit(code)
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "status"
func option(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

let locale = Locale(identifier: option("--locale") ?? Locale.current.identifier)
guard let recognizer = SFSpeechRecognizer(locale: locale) else { fail("no speech recognizer for \(locale.identifier)") }

func speechStatus() -> String {
  switch SFSpeechRecognizer.authorizationStatus() {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: return "not-determined"
  }
}

func micStatus() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: return "not-determined"
  }
}

func authorize(mic: Bool, then: @escaping () -> Void) {
  SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else { fail("speech-denied", code: 3) }
    guard mic else { DispatchQueue.main.async(execute: then); return }
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      guard ok else { fail("mic-denied", code: 3) }
      DispatchQueue.main.async(execute: then)
    }
  }
}

func requireOnDevice() {
  guard recognizer.supportsOnDeviceRecognition else { fail("on-device recognition is not available for \(locale.identifier)") }
  guard recognizer.isAvailable else { fail("speech recognition is not available right now") }
}

// "No speech detected" is an error to the recognizer; to us it's an empty question.
func isNoSpeech(_ error: Error) -> Bool {
  let e = error as NSError
  return e.domain == "kAFAssistantErrorDomain" && (e.code == 1110 || e.code == 203)
}

switch mode {
case "status":
  emit(["event": "status", "speech": speechStatus(), "mic": micStatus(), "onDevice": recognizer.supportsOnDeviceRecognition, "locale": locale.identifier])
  exit(0)

case "file":
  guard args.count > 2 else { fail("usage: buddy-listen file PATH") }
  let url = URL(fileURLWithPath: args[2])
  authorize(mic: false) {
    requireOnDevice()
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    let started = Date()
    recognizer.recognitionTask(with: request) { result, error in
      if let r = result, r.isFinal {
        emit(["event": "final", "text": r.bestTranscription.formattedString, "ms": Int(Date().timeIntervalSince(started) * 1000)])
        exit(0)
      }
      if let error = error { fail(isNoSpeech(error) ? "no speech" : error.localizedDescription) }
    }
  }
  dispatchMain()

case "listen":
  let holdKey = option("--hold-key").flatMap { UInt16($0) }
  let maxMs = Int(option("--max-ms") ?? "") ?? 15000
  let launched = Date()
  // Set once the mic is open; until then a stop only marks the question as let go.
  var stopNow: (() -> Void)? = nil
  var letGo = false
  func requestStop() {
    if let stop = stopNow { stop() } else { letGo = true }
  }

  DispatchQueue.global().async {
    while let line = readLine() {
      if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
    }
    DispatchQueue.main.async { requestStop() }
  }

  var keyTimer: DispatchSourceTimer? = nil
  if let key = holdKey {
    var seenDown = false
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: .milliseconds(30))
    timer.setEventHandler {
      let down = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(key))
      if down { seenDown = true; return }
      if seenDown { timer.cancel(); requestStop(); return }
      if Date().timeIntervalSince(launched) > 0.3 { timer.cancel(); fail("hold-unsupported", code: 4) }
    }
    timer.resume()
    keyTimer = timer
  }
  _ = keyTimer

  if SFSpeechRecognizer.authorizationStatus() == .notDetermined || AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
    emit(["event": "authorizing"])
  }
  authorize(mic: true) {
    if letGo { emit(["event": "cancelled"]); exit(0) }
    requireOnDevice()
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.taskHint = .search
    let engine = AVAudioEngine()
    let input = engine.inputNode
    input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
    engine.prepare()
    do { try engine.start() } catch { fail("microphone would not start: \(error.localizedDescription)") }

    var lastText = ""
    var stoppedAt: Date? = nil
    func finish(_ text: String) -> Never {
      let ms = stoppedAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
      emit(["event": "final", "text": text, "ms": ms])
      exit(0)
    }
    func stop() {
      guard stoppedAt == nil else { return }
      stoppedAt = Date()
      engine.stop()
      input.removeTap(onBus: 0)
      request.endAudio()
      // The recognizer normally answers within a second of endAudio; never hang.
      DispatchQueue.main.asyncAfter(deadline: .now() + 4) { finish(lastText) }
    }

    recognizer.recognitionTask(with: request) { result, error in
      DispatchQueue.main.async {
        if let r = result {
          lastText = r.bestTranscription.formattedString
          if r.isFinal { finish(lastText) }
          emit(["event": "partial", "text": lastText])
        } else if let error = error {
          if isNoSpeech(error) || stoppedAt != nil { finish(lastText) }
          fail(error.localizedDescription)
        }
      }
    }
    stopNow = stop
    emit(["event": "ready"])
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(maxMs)) { stop() }
  }
  dispatchMain()

default:
  fail("unknown mode \(mode)")
}
