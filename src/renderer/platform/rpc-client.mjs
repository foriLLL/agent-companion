function rpcError(code, message) {
  return Object.assign(new Error(message), { code, retryable: code === "RPC_TIMEOUT" });
}

// 连接中断时多久复查一次；后台恢复后由下一次复查或任意回包立即确认。
const RECHECK_MS = 3000;
const CHECK_TIMEOUT_MS = 3000;

export function createRpcClient({ binding = () => globalThis.__AGENT_COMPANION_RPC__, timeoutMs = 70_000,
  recheckMs = RECHECK_MS, checkTimeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const pending = new Map();
  let sequence = 0;
  const prefix = `companion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // 连接状态：请求超时不一定是断了（业务方法可能只是慢），先发一次 ping 确认；
  // 断开期间定时复查，收到任何回包（包括后台自己发起的探活）即视为恢复。
  let connected = true;
  let checking = null;
  let recheckTimer = null;
  let disposed = false;
  const listeners = new Set();

  function setConnected(value) {
    if (value) { clearTimeout(recheckTimer); recheckTimer = null; }
    else scheduleRecheck();
    if (connected === value || disposed) return;
    connected = value;
    for (const listener of [...listeners]) { try { listener(value); } catch {} }
  }

  function scheduleRecheck() {
    if (recheckTimer || disposed) return;
    recheckTimer = setTimeout(() => { recheckTimer = null; void checkConnection(); }, recheckMs);
    // 浏览器里没有 unref；Node 测试中不让复查定时器单独撑住进程。
    recheckTimer.unref?.();
  }

  function checkConnection() {
    if (disposed) return Promise.resolve(connected);
    checking ??= ping(checkTimeoutMs).then((result) => {
      checking = null;
      // 卸载导致的中止不代表后台断开。
      if (result.reason !== "ABORTED") setConnected(result.ok);
      return connected;
    });
    return checking;
  }

  function receiveRpc(raw) {
    let response = raw;
    if (typeof raw === "string") { try { response = JSON.parse(raw); } catch { return false; } }
    // 迟到的回包也说明链路是通的。
    if (typeof response?.id === "string" && response.id.startsWith(prefix)) setConnected(true);
    const request = pending.get(response?.id);
    if (!request) return false;
    request.finish(response.ok === false
      ? Object.assign(new Error(response.error?.message || "请求失败"), response.error)
      : null, response.result);
    return true;
  }

  function notifyCancel(requestId) {
    const request = pending.get(requestId);
    try { binding()?.(JSON.stringify({ id: `${prefix}-cancel-${++sequence}`, method: "rpc.cancel", params: { requestId },
      ...(request ? { cardId: request.cardId, generation: request.generation } : {}) })); } catch {}
  }

  function scoped(cardId, generation, signal) {
    function request(method, params = {}, options = {}) {
      const id = `${prefix}-${++sequence}`;
      const promise = new Promise((resolve, reject) => {
        let timer;
        let settled = false;
        const signals = [...new Set([signal, options.signal].filter(Boolean))];
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          pending.delete(id);
          clearTimeout(timer);
          for (const item of signals) item.removeEventListener("abort", abort);
          if (error) reject(error); else resolve(value);
        };
        const abort = () => { notifyCancel(id); finish(rpcError("ABORTED", "请求已取消")); };
        if (signals.some((item) => item.aborted)) { finish(rpcError("ABORTED", "卡片已卸载")); return; }
        pending.set(id, { cardId, generation, finish, abort });
        for (const item of signals) item.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          notifyCancel(id);
          finish(rpcError("RPC_TIMEOUT", `${method} 请求超时`));
          void checkConnection();
        }, options.timeoutMs ?? timeoutMs);
        try {
          const send = binding();
          if (typeof send !== "function") { setConnected(false); throw rpcError("BRIDGE_UNAVAILABLE", "播放器后台尚未连接"); }
          const qualified = method.startsWith(`${cardId}.`) ? method : `${cardId}.${method}`;
          const result = send(JSON.stringify({ id, method: qualified, params, cardId, generation }));
          // 生产 CDP binding 返回 undefined；测试后端也可直接返回 Promise/结果。
          if (result !== undefined) Promise.resolve(result).then(
            (value) => receiveRpc({ id, ok: true, result: value }),
            (error) => finish(error)
          );
        } catch (error) { finish(error); }
      });
      return { id, promise, cancel: () => pending.get(id)?.abort() };
    }
    const call = (method, params, options) => request(method, params, options).promise;
    call.request = request;
    call.cancel = (id) => {
      const item = pending.get(id);
      if (item?.cardId === cardId && item.generation === generation) item.abort();
    };
    return call;
  }

  // 传输层自检，供后台判断这条链路是否还通：binding 发出 → 后台 bridge 直接回包 → receiveRpc 收到。
  // 不经过任何卡片或业务服务，业务方法慢不会被误判为断线。结果只说明通不通，从不抛错。
  function ping(timeoutMs = 3000) {
    const id = `${prefix}-ping-${++sequence}`;
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        clearTimeout(timer);
        resolve(error ? { ok: false, reason: error.code || error.message || "RPC_ERROR" } : { ok: true });
      };
      pending.set(id, { finish, internal: true, abort: () => finish(rpcError("ABORTED", "请求已取消")) });
      timer = setTimeout(() => finish(rpcError("RPC_TIMEOUT", "rpc.ping 请求超时")), timeoutMs);
      try {
        const send = binding();
        if (typeof send !== "function") throw rpcError("BRIDGE_UNAVAILABLE", "播放器后台尚未连接");
        const result = send(JSON.stringify({ id, method: "rpc.ping", params: {} }));
        // 生产 binding 返回 undefined，回包经 receiveRpc 到达；测试后端可直接返回结果。
        if (result !== undefined) Promise.resolve(result).then(() => finish(null), (error) => finish(error ?? rpcError("RPC_ERROR", "请求失败")));
      } catch (error) { finish(error); }
    });
  }

  const connection = {
    isConnected: () => connected,
    // listener(connected: boolean) 只在状态变化时调用；返回取消订阅函数。
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: checkConnection
  };

  return {
    scoped, receiveRpc, ping, connection,
    // 连接检查的 ping 属于客户端内部，不计入业务在途请求。
    diagnostics: () => ({ pending: [...pending.values()].filter(request => !request.internal).length, connected }),
    dispose() {
      disposed = true;
      clearTimeout(recheckTimer);
      recheckTimer = null;
      listeners.clear();
      for (const request of [...pending.values()]) request.abort();
    }
  };
}
