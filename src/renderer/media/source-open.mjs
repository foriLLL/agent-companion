function sourceError(code, message) {
  return Object.assign(new Error(message), { code, retryable: code !== "ABORTED" });
}

export function waitForMediaSourceOpen(mediaSource, scope, {
  signal,
  documentImpl = globalThis.document,
  timeoutMs = 10_000,
  nowImpl = Date.now
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(sourceError("ABORTED", "播放器已经关闭"));
      return;
    }
    if (mediaSource.readyState === "open") {
      resolve();
      return;
    }
    let timeout = null;
    let startedAt = null;
    let remainingMs = timeoutMs;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      scope.clearTimeout(timeout);
      scope.unlisten(mediaSource, "sourceopen", onOpen);
      scope.unlisten(mediaSource, "sourceclose", onClose);
      scope.unlisten(documentImpl, "visibilitychange", syncVisibility);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onClose = () => finish(sourceError("MSE_CLOSED", "MediaSource 已关闭"));
    const onAbort = () => finish(sourceError("ABORTED", "播放器已经关闭"));
    const syncVisibility = () => {
      if (settled) return;
      if (documentImpl.hidden) {
        if (startedAt !== null) remainingMs = Math.max(0, remainingMs - (nowImpl() - startedAt));
        scope.clearTimeout(timeout);
        timeout = null;
        startedAt = null;
      } else if (timeout === null) {
        startedAt = nowImpl();
        timeout = scope.setTimeout(() => finish(sourceError("MSE_OPEN_TIMEOUT", "MediaSource 启动超时")), remainingMs);
      }
    };
    scope.listen(mediaSource, "sourceopen", onOpen, { once: true });
    scope.listen(mediaSource, "sourceclose", onClose, { once: true });
    scope.listen(documentImpl, "visibilitychange", syncVisibility);
    signal?.addEventListener("abort", onAbort, { once: true });
    syncVisibility();
  });
}
