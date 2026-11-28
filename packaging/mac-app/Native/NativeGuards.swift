import Foundation

struct AppInstance {
  let pid: Int32
  let launchedAt: Int64
  var finishedLaunching: Bool
  var arguments: [String]?
  var key: String { "\(pid):\(launchedAt)" }
  var json: [String: Any] {
    ["pid": pid, "key": key, "launchedAt": launchedAt,
     "finishedLaunching": finishedLaunching, "arguments": arguments as Any? ?? NSNull()]
  }
}

struct InputState {
  var frontmostPid: Int32
  var inputStamp: String
  var inputIdleMs: Double
  var now: Int64
}

// 守卫保持纯函数；生产入口必须在调用 AppKit 动作前读取原生状态再判断。
// fresh 只允许刚启动（默认 30 秒内）、启动完成且未带调试端口的实例；不限前后台与启动后输入，
// 既支持后台启动/自动更新重启，也保证绝不误杀已在运行的旧实例。
func quitRefusal(_ instance: AppInstance?, key: String, mode: String,
                 maxAgeMs: Int64 = 30_000, input: InputState) -> String? {
  guard let instance else { return "instance-mismatch" }
  guard instance.key == key else { return "key-mismatch" }
  if mode == "user" { return nil }
  guard mode == "fresh" else { return "invalid-mode" }
  guard instance.finishedLaunching else { return "not-finished-launching" }
  guard let arguments = instance.arguments else { return "arguments-unknown" }
  guard !arguments.contains(where: { $0 == "--remote-debugging-port" || $0.hasPrefix("--remote-debugging-port=") }) else {
    return "debug-port-present"
  }
  let limit = min(maxAgeMs, 30_000)
  let age = input.now - instance.launchedAt
  guard age >= 0 && age <= limit else { return "age-out-of-range" }
  return nil
}

// 启动完成和隐藏状态只是观测值；等待到期不能把仍存活的已核验实例判成启动失败。
func launchResult(_ current: AppInstance?, key: String, hidden: Bool, waitExpired: Bool) -> [String: Any]? {
  guard let current, current.key == key else { return ["launched": false, "reason": "unverified-instance"] }
  guard current.finishedLaunching || waitExpired else { return nil }
  return ["launched": true, "pid": current.pid, "key": current.key,
          "finishedLaunching": current.finishedLaunching, "hidden": hidden]
}
