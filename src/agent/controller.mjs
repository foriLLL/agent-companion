import { isCompanionDebugInstance, parseCodexDebugArgs } from "./codex-args.mjs";

const STOPPED = Symbol("stopped");

function classify(snapshot, isOurs = isCompanionDebugInstance) {
  return snapshot.apps.map((app) => {
    const parsed = parseCodexDebugArgs(app.arguments);
    // 非法或缺值的调试端口标志也不能当作普通实例退出。
    const hasDebugFlag = parsed.known && app.arguments.some((arg) =>
      arg === "--remote-debugging-port" || arg.startsWith("--remote-debugging-port="));
    const kind = !parsed.known ? "unknown" : isOurs(parsed) ? "ours"
      : hasDebugFlag ? "foreign-debug" : "plain";
    return { ...app, parsed, kind };
  });
}

export class AgentController {
  #adapter;
  #now;
  #sleep;
  #isOurs;
  #autoRelaunch;
  #notifyWhenManual;
  #freshWindowMs;
  #cooldownMs;
  #stableAttachMs;
  #quitTimeoutMs;
  #userRestartMinIntervalMs;
  #lastAttemptAt;
  #hasAttempt;
  #lastUserRestartAt = null;
  #lastEvent = null;
  #attached = null;
  #seen = new Set();
  #reported = new Map();
  #multipleKeys = null;
  #currentSnapshot = null;
  #hasBaseline = false;
  #pendingLaunch = false;
  #queued = null;
  #work = null;
  #stopped = false;

  constructor({ adapter, now = Date.now, sleep, lastAttemptAt = 0, seenKeys = [],
    freshWindowMs = 30000, cooldownMs = 120000, stableAttachMs = 30000, quitTimeoutMs = 10000,
    userRestartMinIntervalMs = 10000, autoRelaunch = () => true, notifyWhenManual = false,
    isOurs = isCompanionDebugInstance }) {
    if (typeof sleep !== "function") throw new TypeError("必须注入 sleep");
    this.#adapter = adapter;
    this.#now = now;
    this.#sleep = sleep;
    this.#isOurs = isOurs;
    this.#autoRelaunch = autoRelaunch;
    // 不能自动重开的平台（Linux）仍提示用户手动重开；macOS 关闭自动重开时保持安静。
    this.#notifyWhenManual = notifyWhenManual;
    this.#freshWindowMs = freshWindowMs;
    this.#cooldownMs = cooldownMs;
    this.#stableAttachMs = stableAttachMs;
    this.#quitTimeoutMs = quitTimeoutMs;
    this.#userRestartMinIntervalMs = userRestartMinIntervalMs;
    this.#lastAttemptAt = lastAttemptAt;
    this.#hasAttempt = lastAttemptAt !== 0;
    for (const key of seenKeys ?? []) {
      if (typeof key === "string" && key) this.#seen.add(key);
    }
  }

  get pendingLaunch() {
    return this.#pendingLaunch;
  }

  status() {
    return {
      attachedKey: this.#attached?.key ?? null,
      attachedPort: this.#attached?.port ?? null,
      lastEvent: this.#lastEvent ? { ...this.#lastEvent } : null,
      lastAttemptAt: this.#lastAttemptAt
    };
  }

  stop() {
    this.#stopped = true;
    this.#pendingLaunch = false;
    this.#queued = null;
  }

  handleSnapshot(snapshot) {
    if (this.#stopped) return Promise.resolve();
    if (this.#work) {
      this.#queued = snapshot;
      return this.#work;
    }
    return this.#start(() => this.#processSnapshot(snapshot));
  }

  #start(operation) {
    // 首个快照单独保留作基线；忙时后续快照只留最后一个。
    this.#work = Promise.resolve().then(async () => {
      try {
        while (true) {
          try {
            await operation();
          } catch (error) {
            await this.#reportError(error);
          }
          if (this.#stopped || !this.#queued) break;
          const snapshot = this.#queued;
          this.#queued = null;
          operation = () => this.#processSnapshot(snapshot);
        }
      } finally {
        this.#work = null;
      }
    });
    return this.#work;
  }

  async #call(method, ...args) {
    if (this.#stopped) throw STOPPED;
    const result = await this.#adapter[method](...args);
    if (this.#stopped) throw STOPPED;
    return result;
  }

  async #pause(ms) {
    if (this.#stopped) throw STOPPED;
    await this.#sleep(ms);
    if (this.#stopped) throw STOPPED;
  }

  async #record(event, details = {}) {
    if (this.#stopped) throw STOPPED;
    this.#lastEvent = { event, at: this.#now() };
    await this.#call("record", event, details);
  }

  async #reportError(error) {
    if (this.#stopped || error === STOPPED) return;
    try {
      await this.#record("error", { message: String(error?.message ?? error) });
    } catch {
      // 持久化自身故障时保留内存状态，不能递归记录或产生未处理的拒绝。
    }
  }

  #trimSeen() {
    if (this.#seen.size <= 256) return;
    this.#seen = new Set(this.#currentSnapshot.apps.map((app) => app.key));
    for (const key of this.#reported.keys()) {
      if (!this.#seen.has(key)) this.#reported.delete(key);
    }
  }

  async #observe(snapshot, apps = classify(snapshot, this.#isOurs)) {
    this.#currentSnapshot = snapshot;
    if (apps.length <= 1) this.#multipleKeys = null;
    try {
      if (this.#attached && !apps.some((app) => app.key === this.#attached.key)) {
        const previous = this.#attached;
        await this.#call("detach", { key: previous.key, reason: "exited" });
        this.#attached = null;
        // 上一次重开已稳定接上并运行了一段时间：清掉冷却，避免随后触发客户端更新重启被 120s 冷却拦住。
        if (this.#now() - previous.attachedAt >= this.#stableAttachMs) this.#hasAttempt = false;
      }
      for (const app of apps) {
        if (app.kind === "unknown" || app.kind === "foreign-debug") {
          this.#seen.add(app.key);
          const reported = this.#reported.get(app.key) ?? new Set();
          if (!reported.has(app.kind)) {
            reported.add(app.kind);
            this.#reported.set(app.key, reported);
            await this.#record(app.kind, { processKey: app.key });
          }
        }
      }
      if (apps.length > 1) {
        for (const app of apps) this.#seen.add(app.key);
        const processKeys = apps.map((app) => app.key).sort();
        const keys = JSON.stringify(processKeys);
        if (keys !== this.#multipleKeys) {
          this.#multipleKeys = keys;
          await this.#record("multiple-instances", { processKeys });
        }
      }
      if (!this.#attached) {
        const app = apps.find((entry) => entry.kind === "ours");
        if (app) {
          this.#seen.add(app.key);
          const attached = { pid: app.pid, key: app.key, port: app.parsed.debugPort };
          await this.#call("attach", attached);
          this.#attached = { ...attached, attachedAt: this.#now() };
        }
      }
      return apps;
    } finally {
      this.#trimSeen();
    }
  }

  #latestSnapshot(snapshot) {
    return this.#queued && this.#queued.now >= snapshot.now ? this.#queued : snapshot;
  }

  #fresh(app, snapshot) {
    const age = snapshot.now - app.launchedAt;
    return Number.isFinite(age) && age >= 0 && age <= this.#freshWindowMs;
  }

  #canQuit(app, snapshot, mode) {
    const latest = this.#latestSnapshot(snapshot);
    const apps = classify(latest, this.#isOurs);
    if (apps.length !== 1 || apps[0].key !== app.key) return false;
    if (mode === "user") return apps[0].kind === "plain" || apps[0].kind === "ours";
    return apps[0].kind === "plain" && this.#fresh(apps[0], latest) && apps[0].finishedLaunching === true;
  }

  async #processSnapshot(snapshot) {
    if (this.#stopped) return;
    // 退出轮询可能已看到更新的事实，不能再用排队的旧快照恢复过期会话。
    if (this.#currentSnapshot && snapshot.now < this.#currentSnapshot.now) return;
    this.#pendingLaunch = false;
    const apps = classify(snapshot, this.#isOurs);
    const baseline = !this.#hasBaseline;
    this.#hasBaseline = true;
    // 基线里已在运行的普通实例（非刚启动的单实例）一律保护：agent 重启、自动更新或重装时绝不打断正在使用的宿主。
    const protectedApps = baseline ? apps.filter((app) => app.kind === "plain"
      && !(apps.length === 1 && this.#fresh(app, snapshot))) : [];
    const newlyProtected = protectedApps.filter((app) => !this.#seen.has(app.key));
    // 必须在首次 await 前保护基线，记录或通知故障也不能让它变成新实例。
    for (const app of protectedApps) this.#seen.add(app.key);
    await this.#observe(snapshot, apps);
    for (const app of newlyProtected) {
      if (this.#autoRelaunch() || this.#notifyWhenManual) {
        await this.#call("notify", "needs-restart", { processKey: app.key });
      } else {
        await this.#record("skipped-disabled", { processKey: app.key });
      }
    }
    const app = apps[0];
    if (apps.length !== 1 || app.kind !== "plain" || this.#seen.has(app.key)) return;
    let pending = false;
    try {
      const details = { processKey: app.key };
      if (!this.#autoRelaunch()) {
        await this.#record("skipped-disabled", details);
        if (this.#notifyWhenManual) await this.#call("notify", "needs-restart", details);
      } else if (!this.#fresh(app, snapshot)) {
        await this.#record("skipped-stale", details);
        await this.#call("notify", "skipped", details);
      } else if (app.finishedLaunching !== true) {
        this.#pendingLaunch = true;
        pending = true;
      } else if (this.#hasAttempt && this.#now() - this.#lastAttemptAt < this.#cooldownMs) {
        await this.#record("skipped-cooldown", details);
        await this.#call("notify", "cooldown", details);
      } else {
        const lastAttemptAt = this.#now();
        await this.#record("attempt", { lastAttemptAt, processKey: app.key });
        this.#lastAttemptAt = lastAttemptAt;
        this.#hasAttempt = true;
        await this.#restartFresh(app, snapshot);
      }
    } finally {
      if (!pending) this.#seen.add(app.key);
      this.#trimSeen();
    }
  }

  async #waitForExit(app, mode) {
    const deadline = this.#now() + this.#quitTimeoutMs;
    // snapshot 也可能迟迟不返回；超时后的返回值必须被丢弃，不能恢复重开流程。
    const timeout = this.#pause(this.#quitTimeoutMs).then(() => null);
    timeout.catch(() => {});
    while (this.#now() < deadline) {
      await this.#pause(Math.min(200, deadline - this.#now()));
      if (this.#now() >= deadline) break;
      const snapshot = await Promise.race([this.#call("snapshot"), timeout]);
      if (!snapshot || this.#now() >= deadline) break;
      const apps = await this.#observe(snapshot);
      if (this.#now() >= deadline) break;
      const latest = this.#latestSnapshot(snapshot);
      if ([...apps, ...latest.apps].some((entry) => entry.key !== app.key)) {
        const seen = [...apps, ...latest.apps].map((entry) => entry.key);
        for (const key of seen) this.#seen.add(key);
        await this.#record("another-instance", { processKey: app.key, processKeys: seen, mode });
        return null;
      }
      if (apps.length === 0 && latest.apps.length === 0) return snapshot;
    }
    await this.#record("quit-timeout", { processKey: app.key, mode });
    if (mode === "fresh") await this.#call("notify", "needs-restart", { processKey: app.key });
    return null;
  }

  async #launch(options, processKey) {
    let result;
    try {
      result = await this.#call("launch", options);
    } catch (error) {
      if (this.#stopped) throw error;
      await this.#record("launch-failed", { processKey, message: String(error?.message ?? error) });
      await this.#call("notify", "relaunch-failed", { processKey });
      throw error;
    }
    if (!result?.launched || !Number.isInteger(result.pid) || result.pid <= 0 || typeof result.key !== "string" || !result.key) {
      await this.#record("launch-failed", { processKey, reason: result?.reason ?? "invalid-result" });
      await this.#call("notify", "relaunch-failed", { processKey });
      return null;
    }
    this.#seen.add(result.key);
    return result;
  }

  async #restartFresh(app, initial) {
    // 等待落盘时可能已经收到新事实，不能把队列串行化当作忽略守卫的理由。
    if (!this.#canQuit(app, initial, "fresh")) {
      await this.#record("quit-refused", { processKey: app.key, reason: "snapshot-changed" });
      return;
    }
    // 刚启动与窗口激活是两条独立通知，先后无保证：初始或排队快照里任一帧在前台，就按前台恢复显示，避免 Dock 点开后像消失了一样。
    const wasFrontmost = initial.frontmostPid === app.pid || this.#latestSnapshot(initial).frontmostPid === app.pid;
    const quit = await this.#call("quit", { pid: app.pid, key: app.key, mode: "fresh", maxAgeMs: this.#freshWindowMs });
    if (!quit.accepted) {
      await this.#record("quit-refused", { processKey: app.key, reason: quit.reason });
      if (quit.reason === "age-out-of-range") {
        await this.#call("notify", "skipped", { processKey: app.key });
      } else if (!["instance-mismatch", "key-mismatch", "debug-port-present"].includes(quit.reason)) {
        await this.#call("notify", "needs-restart", { processKey: app.key });
      }
      return;
    }
    if (!await this.#waitForExit(app, "fresh")) return;
    await this.#pause(250);
    const snapshot = await this.#call("snapshot");
    const apps = await this.#observe(snapshot);
    const latest = this.#latestSnapshot(snapshot);
    if (apps.length || latest.apps.length) {
      const seen = [...apps, ...latest.apps].map((entry) => entry.key);
      for (const key of seen) this.#seen.add(key);
      await this.#record("reopen-canceled", { processKey: app.key, processKeys: seen });
      return;
    }
    // 前台实例保持隐藏重开再显示；后台实例请求不激活重开，尽量避免抢走当前窗口焦点。
    const launched = await this.#launch(wasFrontmost ? { hidden: true } : { background: true }, app.key);
    if (!launched) return;
    const { shown } = wasFrontmost
      ? await this.#call("show", { pid: launched.pid, key: launched.key })
      : { shown: false };
    await this.#record("reopened", { processKey: app.key, key: launched.key, shown });
  }

  requestUserRestart({ reason } = {}) {
    if (this.#stopped) return Promise.resolve({ accepted: false, reason: "stopped" });
    if (this.#work) return Promise.resolve({ accepted: false, reason: "busy" });
    if (this.#lastUserRestartAt !== null
      && this.#now() - this.#lastUserRestartAt < this.#userRestartMinIntervalMs) {
      return Promise.resolve({ accepted: false, reason: "rate-limited" });
    }
    let reply;
    const response = new Promise((resolve) => { reply = resolve; });
    this.#start(async () => {
      try {
        const snapshot = await this.#call("snapshot");
        const apps = await this.#observe(snapshot);
        const app = apps[0];
        const refusal = apps.length !== 1 ? (apps.length ? "multiple-instances" : "not-running")
          : app.kind === "unknown" || app.kind === "foreign-debug" ? app.kind : null;
        if (refusal) {
          await this.#record("user-restart-refused", { reason: refusal });
          reply({ accepted: false, reason: refusal });
          return;
        }
        this.#seen.add(app.key);
        this.#pendingLaunch = false;
        this.#lastUserRestartAt = this.#now();
        reply({ accepted: true });
        await this.#pause(300);
        const current = await this.#call("snapshot");
        await this.#observe(current);
        if (!this.#canQuit(app, current, "user")) {
          await this.#record("user-restart-refused", { processKey: app.key, reason: "instance-changed" });
          return;
        }
        const quit = await this.#call("quit", { pid: app.pid, key: app.key, mode: "user" });
        if (!quit.accepted) {
          await this.#record("user-restart-refused", { processKey: app.key, reason: quit.reason });
          return;
        }
        if (!await this.#waitForExit(app, "user")) return;
        const launched = await this.#launch({ hidden: false }, app.key);
        if (launched) await this.#record("user-restarted", { processKey: app.key, key: launched.key, reason });
      } catch (error) {
        await this.#reportError(error);
        reply({ accepted: false, reason: this.#stopped ? "stopped" : "error" });
      }
    });
    return response;
  }
}
