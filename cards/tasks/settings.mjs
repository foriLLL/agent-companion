import { alertLevel } from "./alerts.mjs";

// 任务看板在 Companion 设置面板里的一节。平台按 manifest 标题建好分组，交给这里一套与面板一致的控件（kit），
// 控件改动只写本卡的 settings；本卡未启用时这些控件由平台一并禁用。
// - 「长任务先列计划」由后台写进 Codex 的全局指令文件（AGENTS.md），并在 config.toml 打开自带的 update_plan 工具；
//   关闭即删除。开启会改动所有新会话，所以先弹确认框，规则全文由平台提供（kit.codex.planHint），和后台写入的一致。
// - 「新会话自动加入看板」由后台扫描宿主新生成的会话记录，各平台都有。
// - 快捷键只在 macOS 显示（Linux 桌面环境自己占用 Alt+Tab，Ctrl+Tab 是 Codex 的切换标签页）。
// - 播放提醒：卡片里有视频在播时，任务需要你或完成就弹出提醒；「暂停」先暂停播放再提醒。
export function settings(kit) {
  const { group, node } = kit;
  const current = () => kit.settings();
  const off = () => !kit.enabled();
  const offHint = "需先启用任务看板";

  const planHintHint = node("small");
  const planHint = kit.checkbox(group, "长任务先列计划", "plan-hint", (value) => {
    if (!value || current().planHint === true) return { planHint: value };
    // 开启前先确认；卡片未启用或面板已关闭时只把开关拨回去。
    planHint.checked = false;
    if (off() || !kit.isOpen()) return null;
    preview.open = false;
    confirmation.open(cancelPlanHint);
    return null;
  }, planHintHint, off);
  const confirmation = kit.confirmation({
    label: "确认修改 Codex 全局指令",
    className: "cc-plan-hint-confirm",
    onCancel(restoreFocus) { if (restoreFocus && kit.isOpen()) planHint.focus({ preventScroll: true }); }
  });
  const title = node("p");
  title.append(node("strong", "开启将修改 Codex 全局指令"));
  const preview = node("details");
  preview.append(node("summary", "查看将追加的完整规则与配置"),
    node("pre", kit.codex.planHint.body), node("pre", kit.codex.planHint.toolSnippet));
  const confirmPlanHint = kit.button("同意修改并开启", () => {
    if (!confirmation.isOpen() || !kit.ready() || off()) return;
    planHint.focus({ preventScroll: true });
    confirmation.cancel(false);
    void kit.save({ planHint: true });
  }, { className: "cc-primary", disabled: off });
  const cancelPlanHint = kit.button("暂不开启", () => confirmation.cancel());
  const actions = node("div", null, "cc-settings-actions");
  actions.append(cancelPlanHint, confirmPlanHint);
  confirmation.element.append(title,
    node("p", "将向 Codex 的全局 AGENTS.md 追加计划规则（若 AGENTS.override.md 非空，则写入它），并在 Codex 的 config.toml 里开启它自带的 update_plan 计划工具。规则会进入模型上下文，两处都影响所有新会话，而不只是看板中的任务。"),
    node("p", "用途：要求长任务先列计划并同步步骤状态。Codex 用 update_plan 工具报告进度，不会出现在对话里；工具不可用时才通过专用进度消息报告，供看板显示进度。不会改写你的输入消息，也不保证任务完成正确。"),
    node("p", "关闭后只删除这段规则和 Companion 写入的 update_plan 设置，保留原有指令与配置；你在 config.toml 里自己设置过 update_plan 的，以你的设置为准。已加载规则的会话不会自动撤回。"),
    preview, actions);
  group.append(confirmation.element);

  const autoAddHint = node("small");
  const autoAdd = kit.checkbox(group, "新会话自动加入看板", "auto-add", (value) => ({ autoAdd: value }), autoAddHint, off);
  const switcherOff = () => off() || current().switcher === false;
  const switcherHint = node("small");
  const switcher = kit.checkbox(group, "快捷键切换看板会话", "switcher", (value) => ({ switcher: value }), switcherHint, off);
  const switcherKeyHint = node("small");
  const switcherKey = kit.choice(group, "切换键", switcherKeyHint, "switcherKey", [["alt", "⌥ Tab"], ["ctrl", "⌃ Tab"]],
    (value) => ({ switcherKey: value }), switcherOff);
  const switcherAllHint = node("small");
  const switcherAll = kit.checkbox(group, "也列出看板外的会话", "switcher-all", (value) => ({ switcherAll: value }),
    switcherAllHint, switcherOff);
  for (const row of [switcher.parentNode, switcherKey.row, switcherAll.parentNode]) row.hidden = !kit.mac;
  const alertNote = node("p", null, "cc-settings-note");
  group.append(alertNote);
  const alertChoices = new Map();
  for (const [key, label, hint] of [["alertAttention", "任务需要你时", "提问、中断或长时间没有动静"], ["alertDone", "任务完成时", "回复结束"]]) {
    alertChoices.set(key, kit.choice(group, label, hint, key, [["off", "关"], ["notify", "提醒"], ["pause", "暂停"]],
      (value) => ({ [key]: value }), off));
  }

  return {
    render() {
      const host = kit.host();
      const hostName = kit.hostName();
      const values = current();
      // 「长任务先列计划」写的是 Codex 的全局指令，只在 Codex 里显示。
      planHint.parentNode.hidden = host !== "codex";
      planHint.checked = values.planHint === true;
      planHintHint.textContent = off() ? offHint : "会修改 Codex 全局 AGENTS.md 并开启 update_plan 工具，影响所有新会话；仅用于列计划和同步进度。开启前需确认，关闭即删除";
      autoAdd.checked = values.autoAdd === true;
      autoAddHint.textContent = off() ? offHint : host === "codex"
        ? "打开后在 Codex 里新开的会话自动加入，移出后不再加回；终端里的 Codex 和子代理不算"
        : "打开后在 Antigravity 里新开的会话自动加入，移出后不再加回；命令行（agy）里的会话不算";
      switcher.checked = values.switcher !== false;
      const ctrl = values.switcherKey === "ctrl";
      const [held, symbol] = ctrl ? ["Control", "⌃"] : ["Option", "⌥"];
      switcherHint.textContent = off() ? offHint : `按住 ${held} 连按 Tab 选择，松开即切换；${symbol}J 跳到需要你处理的会话`;
      switcherKeyHint.textContent = host === "codex" ? "⌃Tab 会盖掉 Codex 的切换标签页" : "⌃Tab 可能和 Antigravity 自己的快捷键冲突";
      for (const [value, input] of switcherKey) input.checked = value === (ctrl ? "ctrl" : "alt");
      switcherAll.checked = values.switcherAll === true;
      switcherAllHint.textContent = `切换面板里加上最近在 ${hostName} 里打开过、但没加入看板的会话`;
      alertNote.textContent = off() ? offHint : "卡片里有视频在播时，任务状态变化会弹出提醒；「暂停」会先暂停播放";
      for (const [key, inputs] of alertChoices) {
        const level = alertLevel(values, key);
        for (const [value, input] of inputs) input.checked = value === level;
      }
    }
  };
}
