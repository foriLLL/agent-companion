function rpcError(code, message) {
  return Object.assign(new Error(message), { code, retryable: code === "RPC_TIMEOUT" });
}

export function createRpcClient({ binding = () => globalThis.__CODEX_COMPANION_RPC__, timeoutMs = 70_000 } = {}) {
  const pending = new Map();
  let sequence = 0;
  const prefix = `companion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function receiveRpc(raw) {
    let response = raw;
    if (typeof raw === "string") { try { response = JSON.parse(raw); } catch { return false; } }
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
        }, options.timeoutMs ?? timeoutMs);
        try {
          const send = binding();
          if (typeof send !== "function") throw rpcError("BRIDGE_UNAVAILABLE", "播放器后台尚未连接");
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
      pending.set(id, { finish, abort: () => finish(rpcError("ABORTED", "请求已取消")) });
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

  return {
    scoped, receiveRpc, ping,
    diagnostics: () => ({ pending: pending.size }),
    dispose() { for (const request of [...pending.values()]) request.abort(); }
  };
}
