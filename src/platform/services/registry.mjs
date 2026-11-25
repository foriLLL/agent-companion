import { rpcError } from "./errors.mjs";

// 方法只能由已加载卡片的 service entry 声明，不能由配置或 RPC 提供模块路径。
// cardApi(manifest) 为每张卡片构造 createService 的参数（见 card-api.mjs 的 createCardApi）；
// 缺省时把 dependencies 原样交给每张卡片（测试用）。
// 构造时登记 modules 里给出的卡片；卡片目录里的卡片由上层按需 register / unregister（安装、启用、更新、卸载）。
export class ServiceRegistry {
  constructor({
    modules = {}, manifests = [], dependencies = {}, loadConfig, logger = console,
    cardApi = (manifest) => ({ ...dependencies, card: { id: manifest.id } })
  } = {}) {
    this.services = new Map();
    this.routes = new Map();
    this.scopes = new Map();
    this.loadConfig = loadConfig;
    this.logger = logger;
    this.cardApi = cardApi;
    this.closed = false;
    for (const manifest of manifests) this.register(manifest, modules[manifest.id] ?? null);
  }

  has(id) {
    return this.services.has(id);
  }

  // 登记一张卡片的后台服务。module 为 null 表示这张卡片没有后台服务，只保留生命周期路由。
  // 服务初始化失败不影响其它卡片：这张卡片的方法调用一律返回 CARD_SERVICE_UNAVAILABLE。
  register(manifest, module = null) {
    if (manifest.id === "companion") throw new TypeError("companion 为平台保留 id，不能注册为卡片");
    if (this.services.has(manifest.id)) throw new TypeError(`卡片 ${manifest.id} 已登记`);
    if (module && typeof module.createService !== "function") throw new TypeError(`卡片 ${manifest.id} 缺少 createService`);
    let service = {};
    let initializationError;
    try { service = module?.createService(this.cardApi(manifest)) ?? {}; }
    catch (error) {
      initializationError = error;
      Promise.resolve().then(() => this.logger.warn?.(`[agent-companion] 卡片 ${manifest.id} 服务初始化失败`)).catch(() => {});
    }
    const entry = { id: manifest.id, service, initializationError, defaultEnabled: manifest.defaultEnabled };
    const routes = [];
    const add = (method, route) => {
      if (this.routes.has(method)) throw new TypeError(`重复 RPC 方法：${method}`);
      routes.push([method, route]);
    };
    for (const [operation, handler] of Object.entries(service.methods ?? {})) {
      if (typeof handler !== "function" || !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/.test(operation) || operation === "lifecycle.dispose") {
        throw new TypeError(`卡片 ${entry.id} 方法声明无效：${operation}`);
      }
      add(`${entry.id}.${operation}`, { entry, operation, handler, cleanup: service.cleanupMethods?.includes(operation) === true });
    }
    for (const [alias, operation] of Object.entries(service.aliases ?? {})) {
      const route = routes.find(([method]) => method === `${entry.id}.${operation}`)?.[1];
      if (!route) throw new TypeError(`卡片 ${entry.id} 别名目标不存在：${operation}`);
      add(alias, route);
    }
    add(`${entry.id}.lifecycle.dispose`, { entry, operation: "lifecycle.dispose", cleanup: true });
    this.services.set(entry.id, entry);
    for (const [method, route] of routes) this.routes.set(method, route);
    entry.methods = routes.map(([method]) => method);
    return entry;
  }

  // 撤下一张卡片的后台服务（卸载、更新或换代码前）：中止并清理它的全部会话，再调用 dispose。
  async unregister(id) {
    const entry = this.services.get(id);
    if (!entry) return;
    for (const method of entry.methods ?? []) if (this.routes.get(method)?.entry === entry) this.routes.delete(method);
    this.services.delete(id);
    const scopes = [...this.scopes.values()].filter(scope => scope.entry === entry);
    try { await this.cleanScopes(scopes); }
    finally {
      for (const scope of scopes) if (this.scopes.get(scope.key) === scope) this.scopes.delete(scope.key);
      await Promise.resolve().then(() => entry.service.dispose?.());
    }
  }

  report(error) {
    Promise.resolve().then(() => this.logger.warn?.(`[agent-companion] 卡片会话清理失败：${error?.code ?? "RPC_ERROR"}`)).catch(() => {});
  }

  scopeFor(entry, context) {
    const modern = context.cardId !== undefined || context.generation !== undefined;
    if (modern && (context.cardId !== entry.id || !Number.isSafeInteger(context.generation) || context.generation < 0)) {
      throw rpcError("RPC_INVALID_REQUEST", "卡片命名空间或 generation 无效");
    }
    const key = JSON.stringify([context.targetId ?? null, context.executionContextId ?? null, entry.id]);
    let scope = this.scopes.get(key);
    const generation = modern ? context.generation : null;
    if (scope && (generation === null ? scope.generation !== null : scope.generation !== null && generation < scope.generation)) {
      throw rpcError("RPC_STALE_GENERATION", "卡片实例已过期");
    }
    if (!scope || scope.generation !== generation) {
      if (scope) { this.retire(scope); void this.cleanupScope(scope).catch(error => this.report(error)); }
      scope = {
        key, entry, generation, targetId: context.targetId, executionContextId: context.executionContextId,
        targetKey: !modern && context.executionContextId === undefined ? context.targetId
          : JSON.stringify(["companion", context.targetId ?? null, context.executionContextId ?? null, entry.id, generation]),
        controller: new AbortController(), disposed: false, cleaning: null, cleanupRequested: false
      };
      this.scopes.set(key, scope);
    }
    return scope;
  }

  retire(scope) {
    scope.disposed = true;
    scope.controller.abort(rpcError("RPC_CANCELLED", "卡片实例已关闭"));
  }

  cleanupScope(scope) {
    scope.cleanupRequested = true;
    if (scope.cleaning) return scope.cleaning;
    scope.cleaning = (async () => {
      // 旧 RPC 可能在清理尚未结束时才创建资源；不能只复用已经取过会话快照的清理。
      while (scope.cleanupRequested) {
        scope.cleanupRequested = false;
        await Promise.resolve().then(() => scope.entry.service.disposeTarget?.(scope.targetKey));
      }
    })().finally(() => { scope.cleaning = null; });
    return scope.cleaning;
  }

  async handleRpc(method, params = {}, context = {}) {
    const route = this.routes.get(method);
    if (!route) {
      if (this.services.get(method.split(".")[0])?.initializationError) {
        throw rpcError("CARD_SERVICE_UNAVAILABLE", "该卡片的后台服务初始化失败，请重启 Companion 后重试");
      }
      throw rpcError("RPC_METHOD_NOT_FOUND", "未知 RPC 方法");
    }
    if (this.closed) throw rpcError("RPC_UNAVAILABLE", "卡片服务已关闭");
    if (context.cardId !== undefined && !method.startsWith(`${context.cardId}.`)) throw rpcError("RPC_INVALID_REQUEST", "RPC 方法与卡片命名空间不匹配");
    const scope = this.scopeFor(route.entry, context);
    if (route.operation === "lifecycle.dispose") {
      this.retire(scope);
      await this.cleanupScope(scope);
      return { disposed: true };
    }
    if (scope.disposed && !route.cleanup) throw rpcError("RPC_STALE_GENERATION", "卡片实例已关闭");
    const signal = route.cleanup ? (context.signal ?? new AbortController().signal)
      : context.signal ? AbortSignal.any([scope.controller.signal, context.signal]) : scope.controller.signal;
    if (signal.aborted) throw signal.reason;
    if (!route.cleanup) {
      const config = await this.loadConfig?.();
      if (signal.aborted) throw signal.reason;
      const setting = config?.cards?.[route.entry.id];
      const enabled = typeof setting === "boolean" ? setting : setting?.enabled ?? route.entry.defaultEnabled;
      if (config?.enabled === false || enabled === false) {
        await this.disposeCard(route.entry.id);
        throw rpcError("CARD_DISABLED", "卡片已关闭");
      }
    }
    try {
      const result = await route.handler(params, { ...context, cardId: route.entry.id, targetId: scope.targetKey, signal });
      if (signal.aborted) throw signal.reason;
      return result;
    } finally {
      // 不遵守 abort 的后端可能迟到创建会话；再次清理旧 scope，不影响新 generation。
      if (scope.disposed) await this.cleanupScope(scope);
    }
  }

  async cleanScopes(scopes) {
    for (const scope of scopes) this.retire(scope);
    const results = await Promise.allSettled(scopes.map(scope => Promise.resolve().then(() => this.cleanupScope(scope))));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async applyConfig(config) {
    const disabled = [...this.scopes.values()].filter(scope => config.enabled === false || config.cards?.[scope.entry.id]?.enabled === false || config.cards?.[scope.entry.id] === false);
    await this.cleanScopes(disabled);
    // 需要跟着配置做本机动作的卡片服务（如任务看板维护 Codex 指令文件）；一张卡失败不影响其它卡。
    for (const entry of this.services.values()) {
      if (typeof entry.service.applyConfig !== "function") continue;
      try { await entry.service.applyConfig(config); }
      catch (error) { this.logger.warn?.(`[agent-companion] 卡片 ${entry.id} 应用配置失败：${error?.code ?? error?.message ?? error}`); }
    }
  }

  async disposeCard(cardId) {
    await this.cleanScopes([...this.scopes.values()].filter(scope => scope.entry.id === cardId));
  }

  async disposeContext(targetId, executionContextId) {
    const scopes = [...this.scopes.values()].filter(scope => scope.targetId === targetId && scope.executionContextId === executionContextId);
    await this.cleanScopes(scopes);
    for (const scope of scopes) if (this.scopes.get(scope.key) === scope) this.scopes.delete(scope.key);
  }

  async disposeTarget(targetId) {
    const scopes = [...this.scopes.values()].filter(scope => scope.targetId === targetId);
    for (const scope of scopes) this.retire(scope);
    const operations = scopes.map(scope => () => this.cleanupScope(scope));
    // 兼容在注册表启用前创建的旧会话；不能让一个同步 throw 阻止其他卡清理。
    for (const { service } of this.services.values()) operations.push(() => service.disposeTarget?.(targetId));
    const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
    for (const scope of scopes) if (this.scopes.get(scope.key) === scope) this.scopes.delete(scope.key);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async dispose() {
    this.closed = true;
    for (const scope of this.scopes.values()) this.retire(scope);
    const results = await Promise.allSettled([...this.services.values()].map(({ service }) => Promise.resolve().then(() => service.dispose?.())));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
