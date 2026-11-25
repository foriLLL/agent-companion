// 新会话自动加入看板：定期列出 Codex 今天和昨天的会话记录，新出现的文件读第一行 session_meta，
// 是用户在桌面端自己新开的会话就交给 onSession 加入看板。
// - 启动后第一轮只取基线：已有的文件全部记为已知，不加；
// - 处理过的文件（无论收不收）都记为已知，所以用户把自动加入的任务移出后不会被再加回来；
// - 第一行还没写完或解析失败时本轮不记，下轮再读；连续 GIVE_UP_MS 仍读不出来就放弃；加入看板失败同样重试到 GIVE_UP_MS；
// - 会话 id 的创建时间早于启动前 GRACE_MS 的不收：从归档里恢复的旧会话会重新出现在 sessions 目录下；
// - 基线只在内存里：后台服务重启时重新取，停机期间新建的会话不补。
export const AUTO_ADD_INTERVAL_MS = 2000;
const GIVE_UP_MS = 30_000;
const GRACE_MS = 10 * 60_000;

// codexSessions：平台提供的会话数据源（api.sessions.source），需有 recentRollouts / sessionMeta，
// 可选 isUserSession(meta) / createdAt(meta)；isValidId 校验会话 id 形状。
export function createSessionWatcher({
  codexSessions, onSession, isValidId = (id) => typeof id === "string" && id !== "", intervalMs = AUTO_ADD_INTERVAL_MS, now = Date.now, logger = console,
  setTimer = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); }
}) {
  let running = false;
  let startedAt = 0;
  let known = null;
  const failing = new Map();
  let cancelTimer = null;
  let scanning = null;
  let ready = Promise.resolve();
  let generation = 0;

  // 每一轮记下开始时的 generation；中途被停止（或停止后又重新开始）就放弃本轮，不动新一轮的状态。
  async function scan() {
    const run = generation;
    const paths = await codexSessions.recentRollouts();
    if (run !== generation) return;
    if (!known) {
      known = new Set(paths);
      return;
    }
    const seen = known;
    const listed = new Set(paths);
    // 跨过零点后前天的目录不再列出，已知集合跟着收缩，不会一直变大。
    for (const path of seen) if (!listed.has(path)) seen.delete(path);
    for (const path of failing.keys()) if (!listed.has(path)) failing.delete(path);
    for (const path of paths) {
      if (run !== generation) return;
      if (seen.has(path)) continue;
      const meta = await codexSessions.sessionMeta(path).catch(() => null);
      if (run !== generation) return;
      if (!meta) {
        const first = failing.get(path) ?? now();
        failing.set(path, first);
        if (now() - first >= GIVE_UP_MS) { failing.delete(path); seen.add(path); }
        continue;
      }
      seen.add(path);
      const id = typeof meta.id === "string" ? meta.id : null;
      // 来源与创建时间由数据源判断（Codex 看 session_meta 与 UUIDv7，Antigravity 看摘要）；不提供时不过滤。
      const created = !id ? null : codexSessions.createdAt?.(meta) ?? null;
      const userSession = codexSessions.isUserSession ? codexSessions.isUserSession(meta) : true;
      if (!id || !isValidId(id) || !userSession || (created !== null && created < startedAt - GRACE_MS)) {
        failing.delete(path);
        continue;
      }
      try {
        await onSession({ threadId: id });
        failing.delete(path);
      } catch (error) {
        // 加入失败（例如看板文件一时写不进去）：先不算处理过，下轮再试；连续 GIVE_UP_MS 仍失败才放弃。只在第一次记日志。
        if (!failing.has(path)) logger.warn?.(`[agent-companion] 新会话加入看板失败：${error?.code ?? error?.message ?? error}`);
        const first = failing.get(path) ?? now();
        failing.set(path, first);
        if (now() - first < GIVE_UP_MS) seen.delete(path);
        else failing.delete(path);
      }
    }
  }

  // 串行执行：上一轮没完成不开下一轮，扫描失败不影响下一轮。同一个错误连着出现只记一次，免得每轮刷一行日志。
  let lastFailure = null;
  function scanOnce() {
    scanning ??= scan()
      .then(() => { lastFailure = null; }, (error) => {
        const reason = String(error?.code ?? error?.message ?? error);
        if (reason !== lastFailure) logger.warn?.(`[agent-companion] 扫描新会话失败：${reason}`);
        lastFailure = reason;
      })
      .finally(() => { scanning = null; });
    return scanning;
  }

  function tick() {
    cancelTimer = null;
    if (!running) return;
    void scanOnce().finally(() => {
      if (running && !cancelTimer) cancelTimer = setTimer(tick, intervalMs);
    });
  }

  return {
    get running() { return running; },
    /** 开始监视；已在运行时不重取基线。返回第一轮（基线）完成的 Promise。 */
    start() {
      if (running) return ready;
      running = true;
      generation += 1;
      startedAt = now();
      known = null;
      failing.clear();
      // 停止前的一轮可能还没结束：等它退出后再取基线。
      const first = Promise.resolve(scanning).then(() => scanOnce());
      ready = first;
      void first.finally(() => {
        if (running && !cancelTimer) cancelTimer = setTimer(tick, intervalMs);
      });
      return first;
    },
    stop() {
      if (!running) return;
      running = false;
      generation += 1;
      cancelTimer?.();
      cancelTimer = null;
      known = null;
      failing.clear();
    },
    scanOnce
  };
}
