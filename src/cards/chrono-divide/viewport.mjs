// 此函数独立运行在游戏页面。用引擎的运行时分辨率重新布局地图、雷达和 HUD，
// 不缩放 canvas 的 CSS，也不改玩家保存在 Graphics 里的首选分辨率。
export function fitBattlefield(win) {
  const key = Symbol.for("codex-companion.chrono-divide.fit");
  if (win[key]) return win[key]();
  const root = win.document.getElementById("ra2web-root");
  if (!root) return;
  let canvas;
  function fit() {
    if (!canvas || !Object.getOwnPropertyDescriptor(win.r ?? {}, "forcesize")?.set) return;
    // 引擎按偶数像素绘制，支持的最小地图视口为 800 × 600。
    const width = Math.max(800, win.innerWidth - win.innerWidth % 2);
    const height = Math.max(600, win.innerHeight - win.innerHeight % 2);
    // 奇数视口居中会留出半像素空白，最外行/列命中 body。用透明边框把
    // 最后一个像素交给 canvas 接收输入，不拉伸像素或盖住游戏的侧栏。
    canvas.style.borderRight = win.innerWidth > width ? "1px solid transparent" : "";
    canvas.style.borderBottom = win.innerHeight > height ? "1px solid transparent" : "";
    if (canvas.clientWidth === width && canvas.clientHeight === height) return;
    const size = width + "x" + height;
    // 加载资源或新开一局时，引擎可能重新应用固定尺寸偏好。
    if (win.r.forcesize === size) win.r.forcesize = undefined;
    win.r.forcesize = size;
  }
  const sizeObserver = new win.ResizeObserver(fit);
  function bind() {
    const next = root.querySelector(":scope > canvas");
    if (canvas !== next) {
      sizeObserver.disconnect();
      canvas = next;
      if (canvas) sizeObserver.observe(canvas);
    }
    fit();
  }
  // 页面持有适配，与原生游戏标签同寿命。反复打开卡片只复用现有监听。
  win[key] = bind;
  new win.MutationObserver(bind).observe(root, { childList: true });
  win.addEventListener("resize", fit);
  bind();
}
