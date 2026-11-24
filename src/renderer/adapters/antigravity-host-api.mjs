/**
 * Antigravity 页面里可读的宿主数据，给声明了 host 能力的卡片用（ctx.host）。
 *
 * 额度：调用 Hub 自己的 agentService.retrieveUserQuotaSummary——Hub 的「模型额度」面板用的就是它，
 * 鉴权由 Hub 自己的客户端处理，这里不读、不传任何 token。客户端对象从 React 根节点往下找
 * （带 retrieveUserQuotaSummary 方法的 props），找到后缓存；页面重载或调用失败时重找一次。
 * 找不到（Antigravity 改版）就报错，卡片显示读不到，不影响其它功能。
 */
export function createAntigravityHostApi({ document } = {}) {
  const MAX_FIBERS = 50_000;
  let service = null;

  function findService() {
    const roots = [document.getElementById("root"), document.body?.firstElementChild].filter(Boolean);
    for (const element of roots) {
      const key = Object.keys(element).find((name) => name.startsWith("__reactContainer$"));
      if (!key) continue;
      const seen = new Set();
      const stack = [element[key]];
      let steps = 0;
      while (stack.length && steps < MAX_FIBERS) {
        const fiber = stack.pop();
        steps += 1;
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        if (props && typeof props === "object") {
          for (const value of [props.agentService, props.value, ...Object.values(props)]) {
            if (value && typeof value === "object" && typeof value.retrieveUserQuotaSummary === "function") return value;
          }
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
    }
    return null;
  }

  const seconds = (stamp) => {
    if (!stamp || typeof stamp !== "object") return null;
    const value = Number(stamp.seconds ?? 0) + Number(stamp.nanos ?? 0) / 1e9;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  // 只取看板要的字段，转成普通 JSON（protobuf 消息里的 bigint、Map 不往外传）。
  function normalize(result) {
    const response = result?.response ?? result ?? {};
    return {
      description: typeof response.description === "string" ? response.description : "",
      groups: (Array.isArray(response.groups) ? response.groups : []).map((group) => ({
        name: typeof group?.displayName === "string" ? group.displayName : "",
        buckets: (Array.isArray(group?.buckets) ? group.buckets : []).map((bucket) => {
          const remaining = bucket?.remaining?.case === "remainingFraction" ? Number(bucket.remaining.value) : NaN;
          return {
            id: String(bucket?.bucketId ?? ""),
            window: String(bucket?.window ?? ""),
            name: typeof bucket?.displayName === "string" ? bucket.displayName : "",
            remaining: Number.isFinite(remaining) ? Math.min(1, Math.max(0, remaining)) : null,
            resetsAt: seconds(bucket?.resetTime),
            description: typeof bucket?.description === "string" ? bucket.description : "",
            disabled: bucket?.disabled === true
          };
        })
      }))
    };
  }

  async function call(force) {
    service ??= findService();
    if (!service) throw Object.assign(new Error("找不到 Antigravity 的额度接口（可能是 Antigravity 改版了）"), { code: "HOST_API_MISSING" });
    return normalize(await service.retrieveUserQuotaSummary(force === true));
  }

  return Object.freeze({
    id: "antigravity",
    /** Antigravity 账号的额度：按模型分组，每组有 5 小时 / 每周等窗口。force 时让 Antigravity 重新向服务端取。 */
    async quota({ force = false } = {}) {
      try { return await call(force); }
      catch (error) {
        if (error?.code === "HOST_API_MISSING" || !service) throw error;
        // 页面重载后旧客户端可能失效：重找一次再试。
        service = null;
        return call(force);
      }
    }
  });
}
