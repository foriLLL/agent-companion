// 红果短剧卡片的样式（只注入本卡 ShadowRoot）。
export const cardStyles = `
        :host { display: block; height: 100%; min-height: 0; }
        * { box-sizing: border-box; }
        button, input { font: inherit; }
        button { color: inherit; }

        /* .panel 的 display:flex 会覆盖 UA 的 [hidden]；显式声明保证卡片开关生效 */
        .panel[hidden] { display: none; }

        .panel {
          width: 100%;
          /* 外框尺寸、圆角、阴影和间距由平台 CardSlot 管理。 */
          height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 0;
          border-radius: 0;
          color: var(--cc-card-fg, var(--hg-panel-color, var(--color-token-text-primary, #1a1c1f)));
          background: transparent;
          box-shadow: none;
          font-family: var(--cc-card-font, var(--hg-font-family, inherit));
          font-size: 13px;
          font-weight: var(--hg-font-weight, 445);
          line-height: 1.45;
          letter-spacing: -.006em;
          -webkit-font-smoothing: antialiased;
        }

        .hg-panel { position: relative; padding: 0; }
        .hg-app, .hg-view { width: 100%; height: 100%; min-height: 0; }
        .hg-view { display: flex; flex-direction: column; animation: hg-fade-in 150ms ease-out; }
        @keyframes hg-fade-in { from { opacity: 0; } to { opacity: 1; } }
        .hg-toolbar {
          position: relative;
          z-index: 3;
          height: 36px;
          min-height: 36px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 10px 10px 4px 13px;
          background: transparent;
          color: var(--cc-card-fg, var(--hg-panel-color, #1a1c1f));
        }
        .hg-toolbar-title {
          min-width: 0;
          flex: 1;
          overflow: hidden;
          margin: 0;
          font-size: var(--cc-section-title-size, 13px);
          font-weight: var(--cc-section-title-weight, 600);
          color: var(--cc-section-title-color, inherit);
          letter-spacing: -.006em;
          line-height: 20px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hg-icon-button, .hg-button, .hg-result, .hg-feature, .hg-episode {
          border: 0;
          color: inherit;
          background: transparent;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }
        .hg-icon-button {
          width: 24px;
          height: 24px;
          display: grid;
          flex: 0 0 auto;
          place-items: center;
          padding: 0;
          border-radius: 6px;
          color: var(--cc-card-fg-muted, var(--hg-header-color, rgba(26,28,31,.58)));
          transition: background-color 120ms ease, color 120ms ease;
        }
        .hg-icon-button svg {
          width: 14px;
          height: 14px;
          display: block;
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.4;
        }
        .hg-icon-button:hover, .hg-icon-button:focus-visible, .hg-button:hover, .hg-button:focus-visible,
        .hg-result:hover, .hg-result:focus-visible, .hg-feature:hover, .hg-feature:focus-visible,
        .hg-episode:hover, .hg-episode:focus-visible {
          outline: none;
          background: var(--cc-card-hover, rgba(127,127,127,.08));
        }
        .hg-icon-button:focus-visible, .hg-button:focus-visible, .hg-result:focus-visible,
        .hg-feature:focus-visible, .hg-episode:focus-visible {
          box-shadow: inset 0 0 0 2px var(--cc-card-focus, var(--color-token-focus-border, #3a83f7));
        }
        .hg-icon-button:hover, .hg-icon-button:focus-visible { color: var(--cc-card-fg, currentColor); }
        .hg-scroll {
          min-height: 0;
          flex: 1;
          overflow-x: hidden;
          overflow-y: auto;
          /* 内层滚到底不再链式带动外层 rail（此前 y:auto 会把 Emby 卡顶走） */
          overscroll-behavior: contain;
          scrollbar-width: thin;
          scrollbar-color: rgba(127,127,127,.34) transparent;
        }
        .hg-scroll::-webkit-scrollbar { width: 4px; }
        .hg-scroll::-webkit-scrollbar-thumb { background: rgba(127,127,127,.34); border-radius: 2px; }
        .hg-scroll::-webkit-scrollbar-track { background: transparent; }
        .hg-content { padding: 8px 13px 14px; }
        .hg-search-form { display: flex; gap: 6px; margin-bottom: 12px; }
        .hg-search-input {
          min-width: 0;
          height: 30px;
          flex: 1;
          padding: 0 9px;
          border: 1px solid var(--cc-card-border, var(--hg-divider, rgba(26,28,31,.12)));
          border-radius: 8px;
          outline: none;
          color: inherit;
          background: var(--cc-card-input-bg, rgba(127,127,127,.045));
          font-size: 12px;
          transition: border-color 140ms ease, box-shadow 140ms ease;
        }
        .hg-search-input:focus {
          border-color: var(--cc-card-focus, var(--color-token-focus-border, #3a83f7));
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--cc-card-focus, #3a83f7) 20%, transparent);
        }
        .hg-button {
          min-height: 30px;
          padding: 0 11px;
          border: 1px solid var(--cc-card-border, var(--hg-divider, rgba(26,28,31,.12)));
          border-radius: 8px;
          background: transparent;
          font-size: 11.5px;
          font-weight: 500;
          transition: background-color 120ms ease, opacity 120ms ease;
        }
        .hg-button.primary {
          border-color: transparent;
          color: var(--cc-card-bg, Canvas);
          background: var(--cc-card-fg, CanvasText);
        }
        .hg-button.primary:hover, .hg-button.primary:focus-visible {
          background: var(--cc-card-fg, CanvasText);
          opacity: .86;
        }
        .hg-button.primary:focus-visible {
          outline: 2px solid var(--cc-card-focus, var(--color-token-focus-border, #3a83f7));
          outline-offset: 2px;
          box-shadow: none;
        }
        .hg-caption, .hg-muted {
          color: var(--cc-card-fg-muted, var(--hg-header-color, rgba(26,28,31,.55)));
          font-size: 10.5px;
          line-height: 15px;
        }
        .hg-caption { margin: 6px 1px 11px; }
        .hg-section-title {
          margin: 0 0 6px;
          color: var(--cc-card-fg-muted, var(--hg-header-color, rgba(26,28,31,.55)));
          font-size: 11px;
          font-weight: 500;
          line-height: 16px;
        }
        .hg-feature-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .hg-feature { min-width: 0; padding: 0; border-radius: 9px; text-align: left; }
        .hg-feature-poster {
          position: relative;
          width: 100%;
          aspect-ratio: 3 / 4;
          display: grid;
          place-items: center;
          overflow: hidden;
          border: 1px solid var(--cc-card-border, rgba(127,127,127,.12));
          border-radius: 8px;
          color: rgba(255,255,255,.68);
          background: linear-gradient(150deg, #353944, #1c1e24);
          font-size: 11px;
        }
        .hg-feature-poster img, .hg-result-poster img, .hg-detail-poster img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
        .hg-feature-name { display: block; overflow: hidden; margin: 5px 1px 2px; font-size: 11.5px; font-weight: 500; line-height: 15px; text-overflow: ellipsis; white-space: nowrap; }
        .hg-feed-status { min-height: 40px; display: grid; place-items: center; padding: 8px 0 2px; color: var(--cc-card-fg-muted, rgba(26,28,31,.55)); font-size: 10.5px; text-align: center; }
        .hg-feed-status .hg-button { min-height: 28px; }
        .hg-inline-status { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 32px; margin-top: 8px; color: var(--cc-card-fg-muted, rgba(26,28,31,.55)); font-size: 10.5px; }
        .hg-mini-spinner { width: 13px; height: 13px; border: 1.5px solid var(--cc-bar-track, rgba(127,127,127,.2)); border-top-color: currentColor; border-radius: 50%; animation: hg-spin .8s linear infinite; }
        .hg-results { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
        .hg-result { width: 100%; min-height: 64px; display: flex; align-items: center; gap: 9px; padding: 5px 6px; border-radius: var(--cc-card-row-radius, 8px); text-align: left; }
        .hg-result-poster { position: relative; width: 40px; height: 54px; display: grid; flex: 0 0 auto; place-items: center; overflow: hidden; border: 1px solid var(--cc-card-border, rgba(127,127,127,.12)); border-radius: 7px; color: rgba(255,255,255,.72); background: linear-gradient(150deg, #353944, #1c1e24); font-size: 9px; }
        .hg-result-copy { min-width: 0; flex: 1; }
        .hg-result-name { display: block; overflow: hidden; font-size: 12px; font-weight: 500; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }
        .hg-list-row { display: flex; align-items: center; gap: 2px; }
        .hg-list-row .hg-result { flex: 1; min-width: 0; }
        .hg-list-remove { flex: 0 0 auto; opacity: .55; }
        .hg-list-remove:hover, .hg-list-remove:focus-visible { opacity: 1; }
        .hg-list-toggle {
          display: block; margin: 2px 0 12px 6px; padding: 2px 0; border: 0; background: none; cursor: pointer;
          color: var(--cc-card-fg-muted, rgba(26,28,31,.55)); font: inherit; font-size: 11px; line-height: 16px;
        }
        .hg-list-toggle:hover, .hg-list-toggle:focus-visible { color: inherit; text-decoration: underline; }
        .hg-empty, .hg-center { display: grid; place-items: center; text-align: center; color: var(--cc-card-fg-muted, rgba(26,28,31,.55)); }
        .hg-empty { min-height: 96px; padding: 16px; border: 1px dashed var(--cc-card-border-strong, rgba(26,28,31,.14)); border-radius: 10px; font-size: 11.5px; }
        .hg-center { min-height: 100%; align-content: center; gap: 10px; padding: 24px; }
        .hg-spinner { width: 22px; height: 22px; border: 1.8px solid var(--cc-bar-track, rgba(127,127,127,.2)); border-top-color: currentColor; border-radius: 50%; animation: hg-spin .8s linear infinite; }
        @keyframes hg-spin { to { transform: rotate(360deg); } }
        .hg-error-title { color: var(--cc-card-fg, currentColor); font-size: 12.5px; font-weight: 600; }
        .hg-error-actions { display: flex; gap: 8px; }
        .hg-detail-hero { position: relative; display: flex; gap: 10px; padding: 10px 13px; }
        .hg-detail-hero::after { content: ""; position: absolute; right: 13px; bottom: 0; left: 13px; height: 1px; background: var(--cc-card-border, rgba(26,28,31,.09)); }
        .hg-detail-poster { position: relative; width: 56px; height: 78px; display: grid; flex: 0 0 auto; place-items: center; overflow: hidden; border: 1px solid var(--cc-card-border, rgba(127,127,127,.12)); border-radius: 8px; color: rgba(255,255,255,.72); background: linear-gradient(150deg, #353944, #1c1e24); font-size: 10px; }
        .hg-detail-copy { min-width: 0; flex: 1; }
        .hg-detail-title { margin: 2px 0 3px; font-size: 13px; font-weight: 600; line-height: 18px; }
        .hg-detail-description { display: -webkit-box; overflow: hidden; margin-top: 5px; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
        .hg-season-picker { display: flex; align-items: center; gap: 8px; padding: 10px 13px 0; font-size: 11px; }
        .hg-season-select { min-width: 0; flex: 1; }
        .hg-episode-grid { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 6px; padding: 10px 13px 13px; }
        .hg-episode { height: 30px; padding: 0; border: 1px solid var(--cc-card-border, rgba(127,127,127,.12)); border-radius: 7px; background: transparent; font-size: 11px; font-variant-numeric: tabular-nums; }
        .hg-episode.locked, .hg-episode.locked:hover { cursor: not-allowed; opacity: .38; background: transparent; }
        .hg-playback { position: relative; width: 100%; height: 100%; overflow: hidden; outline: none; background: #000; }
        .hg-video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
        .hg-playback-chrome { position: absolute; z-index: 3; top: 0; right: 0; left: 0; display: flex; align-items: center; gap: 8px; padding: 9px; color: #fff; background: linear-gradient(rgba(0,0,0,.72), transparent); opacity: 0; pointer-events: none; transition: opacity 120ms ease-out; }
        .hg-playback:hover .hg-playback-chrome, .hg-playback:focus .hg-playback-chrome, .hg-playback:focus-within .hg-playback-chrome { opacity: 1; pointer-events: auto; }
        /* 暂停时常显：JS 同步的 data-paused（不用 :has()/:paused，见 emby 侧注释） */
        .hg-playback[data-paused="true"] .hg-playback-chrome { opacity: 1; pointer-events: auto; }
        .hg-playback-back { color: #fff; background: rgba(0,0,0,.46); backdrop-filter: blur(8px); }
        .hg-playback-title { min-width: 0; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
        .hg-playback-status { position: absolute; z-index: 2; inset: 0; display: grid; place-items: center; align-content: center; gap: 10px; padding: 24px; color: rgba(255,255,255,.82); background: rgba(0,0,0,.32); font-size: 11px; text-align: center; }
        .hg-playback-status[hidden] { display: none; }
        .hg-autoplay {
          position: absolute;
          z-index: 4;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 24px;
          color: #fff;
          background: rgba(0,0,0,.72);
          text-align: center;
          backdrop-filter: blur(8px);
        }
        .hg-autoplay[hidden] { display: none; }
        .hg-autoplay-card { display: grid; justify-items: center; gap: 7px; width: 100%; max-width: 250px; }
        .hg-autoplay-title { font-size: 15px; font-weight: 650; line-height: 21px; }
        .hg-autoplay-detail { min-height: 16px; color: rgba(255,255,255,.68); font-size: 11px; line-height: 16px; }
        .hg-autoplay-actions { display: flex; justify-content: center; gap: 8px; margin-top: 7px; }
        .hg-autoplay .hg-button { color: #fff; border-color: rgba(255,255,255,.18); background: rgba(255,255,255,.14); }
        .hg-autoplay .hg-button.primary { color: #111; border-color: transparent; background: #fff; }
        @media (prefers-reduced-motion: reduce) {
          .hg-view { animation: none; }
          .hg-spinner, .hg-mini-spinner { animation: none !important; }
        }
        /* 原生全屏只会带上 <video>，自定义 chrome（返回/字幕/选集）会丢失；
           统一藏掉原生全屏按钮，走 chrome 里的容器全屏（makeFullscreenButton）。 */
        .hg-video::-webkit-media-controls-fullscreen-button {
          display: none;
        }
        /* 鼠标静止 2.5s 后隐藏画面上的控件；全屏下连光标一起隐藏（对齐原生 controls）。 */
        .hg-playback:fullscreen[data-mouse-idle="true"] {
          cursor: none;
        }
        .hg-playback:fullscreen[data-mouse-idle="true"] .hg-playback-chrome {
          opacity: 0;
          pointer-events: none;
        }

`;
