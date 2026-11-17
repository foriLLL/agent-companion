export const PLAN_HINT_START = "<!-- codex-companion:plan-hint 由 Codex Companion 维护，在 Companion 设置里关闭即可删除 -->";
export const PLAN_HINT_END = "<!-- /codex-companion:plan-hint -->";
export const PLAN_HINT_BODY = [
  "## 任务计划",
  "- 预计要 3 步以上或超过 5 分钟的任务，动手前列出完整计划：每步一句话，按执行顺序排列。",
  "- 当前工具列表有 update_plan 时只用它报告计划，不再输出 companion-plan 代码块；没有时直接用下面的进度消息格式替代，不寻找、不假装调用，也不用反复解释工具缺失。",
  "- 每一步开始和完成时更新完整计划快照，只保留一个 in_progress，其余用 pending 或 completed；步骤措辞保持稳定，计划改变时同步调整。",
  "- 无 update_plan 时，只在助手进度消息（commentary）中输出一个 companion-plan 代码块，内容为严格 JSON，可在块前后附带简短进度说明。格式如下，替换成实际步骤和状态：",
  "```companion-plan",
  '{"plan":[{"step":"检查现状","status":"in_progress"},{"step":"实现改动","status":"pending"},{"step":"验证结果","status":"pending"}]}',
  "```",
  "- 代码块开头的 ```companion-plan 和结尾的 ``` 各自单独占一行；结尾的 ``` 之后先换行并空一行，再写其它文字。",
  "- 最终回答里不输出 companion-plan 代码块，也不附计划快照；最后一步完成的快照放在最终回答之前的一条进度消息里。",
  "- 每次发送完整 plan 数组，每步仅含 step 和 status；最多 50 步，每步不超过 200 字。可选 explanation 不超过 300 字。不写文件、不执行命令来伪造进度。",
  "- companion-plan 标记只用于当前任务的真实进度报告；讲解协议或展示示例时使用普通 json 代码块，不使用这个标记。",
  "- 只在实际完成后标记 completed，不把计划进度当作验证通过；简单问答、一两步就能完成的任务不用列计划。"
].join("\n");

// 同一个开关还在 Codex 的 config.toml 里打开它自带的 update_plan 计划工具（默认关闭）：
// 进度走工具调用，不再以代码块出现在对话里。标记注释紧贴表头，Codex 用 toml_edit 改写文件时会随表一起保留。
export const PLAN_TOOL_MARKER = "# codex-companion:plan-tool 由 Codex Companion 维护（开启 Codex 自带的 update_plan 计划工具），在 Companion 设置里关闭「长任务先列计划」即可删除";
export const PLAN_TOOL_SNIPPET = "[tools.update_plan]\nenabled = true";
