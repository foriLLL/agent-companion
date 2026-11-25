import * as emby from "../../cards/emby/service.mjs";
import * as hongguo from "../../cards/hongguo/service.mjs";
import * as proxy from "../../cards/proxy/service.mjs";
import * as tasks from "../../cards/tasks/service.mjs";
import * as usage from "../../cards/usage/service.mjs";

// 内置卡片的后台服务模块，按 manifest 顺序；测试直接交给 AgentCompanionService / ServiceRegistry，
// 不经卡片目录的动态加载。
export const BUILTIN_SERVICES = Object.freeze({ proxy, usage, tasks, hongguo, emby });
