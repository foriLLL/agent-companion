// 看板条目用的计划摘要。输入是会话数据源 plan(id) 返回的统一格式：
// { steps: [{ text, status: "pending" | "in_progress" | "completed" }], source?: "message", ... }
/** 总步数、完成数、进行中的那一步。 */
export function planSummary(plan) {
  if (!plan?.steps?.length) return null;
  const active = plan.steps.findIndex((step) => step.status === "in_progress");
  return {
    total: plan.steps.length,
    done: plan.steps.filter((step) => step.status === "completed").length,
    active: active >= 0 ? active : null,
    steps: plan.steps.map(({ text, status }) => ({ text, status })),
    ...(plan.source === "message" ? { source: "message" } : {})
  };
}
