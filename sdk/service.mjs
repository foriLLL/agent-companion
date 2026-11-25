// 卡片后台（service.mjs）可以使用的公共库。卡片只能从 sdk/ 引入平台代码：
// 这些模块会在构建时打包进卡片自己的产物，运行时不依赖平台内部文件。
// 需要平台在运行时提供的能力（数据目录、会话数据源、媒体拦截等）不在这里，
// 由 createService(api) 的 api 参数注入，见 cards/README.md。
export { rpcError } from "../src/platform/services/errors.mjs";
export { replaceFile } from "../src/platform/replace-file.mjs";
export { searchPathCandidates, isPathInside, companionDataDir, legacyCompanionDataDir } from "../src/platform/paths.mjs";
export { createSecretStore, SecretStoreError } from "../src/platform/secret-store.mjs";
