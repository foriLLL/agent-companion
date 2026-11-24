// 由 scripts/generate-card-registry.mjs 生成。请勿手改。
// mode: require-entries

import * as service0 from "./proxy/service.mjs";
import * as service1 from "./usage/service.mjs";
import * as service2 from "./tasks/service.mjs";
import * as service3 from "./hongguo/service.mjs";
import * as service4 from "./emby/service.mjs";

export const SERVICE_REGISTRY = Object.freeze({
  "proxy": service0,
  "usage": service1,
  "tasks": service2,
  "hongguo": service3,
  "emby": service4,
});
