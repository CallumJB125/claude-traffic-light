// buddy-calendar: the one thing Electron can't do, reading EventKit.
//
//   buddy-calendar status                 current permission, never prompts
//   buddy-calendar request                asks once (the system prompt names Plexiform)
//   buddy-calendar events FROM TO [--titles]
//                                         events overlapping [FROM, TO] (epoch ms)
//
// Always prints one JSON object on stdout and exits 0; main.js treats
// anything else as "calendar unavailable". Only times, availability and
// whether you declined are read; titles only with --titles (a Settings opt-in).
import EventKit
import Foundation

let store = EKEventStore()

func statusName(_ s: EKAuthorizationStatus) -> String {
  switch s {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .authorized: return "fullAccess" // macOS 12/13's only grant, read + write
  default:
    if #available(macOS 14.0, *) {
      if s == .fullAccess { return "fullAccess" }
      if s == .writeOnly { return "writeOnly" }
    }
    return "unknown"
  }
}

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func availabilityName(_ a: EKEventAvailability) -> String {
  switch a {
  case .busy: return "busy"
  case .free: return "free"
  case .tentative: return "tentative"
  case .unavailable: return "unavailable"
  default: return "notSupported"
  }
}

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "status"
let current = { statusName(EKEventStore.authorizationStatus(for: .event)) }

switch cmd {
case "status":
  emit(["status": current()])

case "request":
  let done = DispatchSemaphore(value: 0)
  var granted = false
  // Full access is the only level that can read events; write-only can't.
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, _ in granted = ok; done.signal() }
  } else {
    store.requestAccess(to: .event) { ok, _ in granted = ok; done.signal() }
  }
  _ = done.wait(timeout: .now() + 120)
  emit(["status": current(), "granted": granted])

case "events":
  guard current() == "fullAccess" else { emit(["status": current(), "error": "not-authorized"]) }
  guard args.count >= 4, let from = Double(args[2]), let to = Double(args[3]) else { emit(["status": current(), "error": "usage"]) }
  let titles = args.contains("--titles")
  let start = Date(timeIntervalSince1970: from / 1000)
  let end = Date(timeIntervalSince1970: to / 1000)
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
  var out: [[String: Any]] = []
  for ev in store.events(matching: predicate) {
    let me = ev.attendees?.first(where: { $0.isCurrentUser })
    var row: [String: Any] = [
      "start": ev.startDate.timeIntervalSince1970 * 1000,
      "end": ev.endDate.timeIntervalSince1970 * 1000,
      "allDay": ev.isAllDay,
      "availability": availabilityName(ev.availability),
      "cancelled": ev.status == .canceled,
      "declined": me?.participantStatus == .declined,
    ]
    if titles { row["title"] = ev.title ?? "" }
    out.append(row)
  }
  emit(["status": "fullAccess", "events": out])

default:
  emit(["error": "unknown-command"])
}
