// 红果短剧卡片的样式（只注入本卡 ShadowRoot）。
export const cardStyles = `
        :host { display: block; height: 100%; min-height: 0; }
        /* 语义色：错误/危险统一一个红（#c84848；深底上 #c33f3f 对比度仅约 3:1 偏弱） */
        :host { --cc-danger: #c84848; }
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
          color: var(--hg-panel-color, var(--color-token-text-primary, #1a1c1f));
          background: transparent;
          box-shadow: none;
          font-family: var(--hg-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          font-size: 14px;
          font-weight: var(--hg-font-weight, 445);
          line-height: 21px;
        }

        .hg-panel { position: relative; padding: 0; }
        .hg-app, .hg-view { width: 100%; height: 100%; min-height: 0; }
        .hg-view { display: flex; flex-direction: column; animation: hg-fade-in 150ms ease-out; }
        @keyframes hg-fade-in { from { opacity: 0; } to { opacity: 1; } }
        .hg-toolbar {
          position: relative;
          z-index: 3;
          height: 40px;
          min-height: 40px;
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 12px 10px 4px 14px;
          background: transparent;
          color: var(--hg-panel-color, var(--color-token-text-primary, #1a1c1f));
        }
        .hg-toolbar-title {
          min-width: 0;
          flex: 1;
          overflow: hidden;
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: -.006em;
          line-height: 21px;
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
          /* toolbar 内容盒 26px（38 - 10 - 2），27px 会溢出 1px */
          width: 26px;
          height: 26px;
          display: grid;
          flex: 0 0 auto;
          place-items: center;
          padding: 0;
          border-radius: 9px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.58)));
        }
        .hg-icon-button svg {
          width: 16px;
          height: 16px;
          display: block;
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.5;
        }
        .hg-icon-button:hover, .hg-icon-button:focus-visible, .hg-button:hover, .hg-button:focus-visible,
        .hg-result:hover, .hg-result:focus-visible, .hg-feature:hover, .hg-feature:focus-visible,
        .hg-episode:hover, .hg-episode:focus-visible {
          outline: none;
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
        }
        .hg-scroll {
          min-height: 0;
          flex: 1;
          overflow-x: hidden;
          overflow-y: auto;
          /* 内层滚到底不再链式带动外层 rail（此前 y:auto 会把 Emby 卡顶走） */
          overscroll-behavior: contain;
          /* 纵向长列表保留 4px 细滚动条作位置提示（横向行不在此列，太吵） */
          scrollbar-width: thin;
          scrollbar-color: rgba(127,127,127,.38) transparent;
        }
        .hg-scroll::-webkit-scrollbar { width: 4px; }
        .hg-scroll::-webkit-scrollbar-thumb { background: rgba(127,127,127,.38); border-radius: 2px; }
        .hg-scroll::-webkit-scrollbar-track { background: transparent; }
        .hg-content { padding: 8px 14px 16px; }
        .hg-search-form { display: flex; gap: 7px; margin-bottom: 14px; }
        .hg-search-input {
          min-width: 0;
          height: 34px;
          flex: 1;
          padding: 0 10px;
          border: .5px solid var(--hg-divider, var(--color-token-border-default, rgba(26,28,31,.16)));
          border-radius: 10px;
          outline: none;
          color: inherit;
          background: var(--hg-input-bg, rgba(127,127,127,.055));
          font-size: 12px;
        }
        .hg-search-input:focus { border-color: rgba(208,76,76,.72); box-shadow: 0 0 0 2px rgba(208,76,76,.10); }
        .hg-button {
          min-height: 34px;
          padding: 6px 11px;
          border-radius: 10px;
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
          font-size: 12px;
          font-weight: 600;
        }
        .hg-button.primary { color: #fff; background: #bb3e48; }
        .hg-caption, .hg-muted {
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 10px;
          line-height: 15px;
        }
        .hg-caption { margin: 7px 1px 13px; }
        .hg-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 650; line-height: 17px; }
        .hg-feature-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
        .hg-feature { min-width: 0; padding: 0; border-radius: 11px; text-align: left; }
        .hg-feature-poster {
          position: relative;
          width: 100%;
          aspect-ratio: 3 / 4;
          display: grid;
          place-items: center;
          overflow: hidden;
          border-radius: 10px;
          color: rgba(255,255,255,.72);
          background: linear-gradient(145deg, #a84c4d, #4c2028);
          font-size: 11px;
        }
        .hg-feature-poster img, .hg-result-poster img, .hg-detail-poster img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
        .hg-feature-name { display: block; overflow: hidden; margin: 5px 2px 2px; font-size: 11px; line-height: 15px; text-overflow: ellipsis; white-space: nowrap; }
        .hg-feed-status { min-height: 42px; display: grid; place-items: center; padding: 10px 0 2px; color: var(--hg-header-color, rgba(26,28,31,.55)); font-size: 10px; text-align: center; }
        .hg-feed-status .hg-button { min-height: 29px; }
        .hg-inline-status { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; margin-top: 8px; color: var(--hg-header-color, rgba(26,28,31,.55)); font-size: 10px; }
        .hg-mini-spinner { width: 14px; height: 14px; border: 1.5px solid rgba(127,127,127,.2); border-top-color: #bb3e48; border-radius: 50%; animation: hg-spin .8s linear infinite; }
        .hg-results { display: flex; flex-direction: column; gap: 2px; margin-top: 10px; }
        .hg-result { width: 100%; min-height: 74px; display: flex; align-items: center; gap: 9px; padding: 6px; border-radius: 11px; text-align: left; }
        .hg-result-poster { position: relative; width: 44px; height: 62px; display: grid; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 7px; color: #fff; background: linear-gradient(145deg, #a84c4d, #4c2028); font-size: 9px; }
        .hg-result-copy { min-width: 0; flex: 1; }
        .hg-result-name { display: block; overflow: hidden; font-size: 12px; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }
        .hg-list-row { display: flex; align-items: center; gap: 2px; }
        .hg-list-row .hg-result { flex: 1; min-width: 0; }
        .hg-list-remove { flex: 0 0 auto; opacity: .55; }
        .hg-list-remove:hover, .hg-list-remove:focus-visible { opacity: 1; }
        .hg-list-toggle {
          display: block; margin: 2px 0 14px 6px; padding: 2px 0; border: 0; background: none; cursor: pointer;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55))); font: inherit; font-size: 11px; line-height: 16px;
        }
        .hg-list-toggle:hover, .hg-list-toggle:focus-visible { color: inherit; text-decoration: underline; }
        .hg-empty, .hg-center { display: grid; place-items: center; text-align: center; color: var(--hg-header-color, rgba(26,28,31,.55)); }
        .hg-empty { min-height: 110px; padding: 18px; border: .5px dashed var(--hg-divider, rgba(26,28,31,.12)); border-radius: 13px; font-size: 11px; }
        .hg-center { min-height: 100%; align-content: center; gap: 10px; padding: 24px; }
        .hg-spinner { width: 27px; height: 27px; border: 2px solid rgba(127,127,127,.2); border-top-color: #bb3e48; border-radius: 50%; animation: hg-spin .8s linear infinite; }
        @keyframes hg-spin { to { transform: rotate(360deg); } }
        .hg-error-title { color: var(--hg-panel-color, currentColor); font-size: 13px; font-weight: 650; }
        .hg-error-actions { display: flex; gap: 8px; }
        .hg-detail-hero { position: relative; display: flex; gap: 11px; padding: 12px 14px; }
        .hg-detail-hero::after { content: ""; position: absolute; right: 14px; bottom: 0; left: 14px; height: .5px; background: var(--hg-divider, rgba(26,28,31,.078)); }
        .hg-detail-poster { position: relative; width: 62px; height: 86px; display: grid; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 9px; color: #fff; background: linear-gradient(145deg, #a84c4d, #4c2028); font-size: 10px; }
        .hg-detail-copy { min-width: 0; flex: 1; }
        .hg-detail-title { margin: 2px 0 4px; font-size: 14px; font-weight: 650; line-height: 19px; }
        .hg-detail-description { display: -webkit-box; overflow: hidden; margin-top: 6px; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
        .hg-season-picker { display: flex; align-items: center; gap: 8px; padding: 12px 14px 0; font-size: 11px; }
        .hg-season-select { min-width: 0; flex: 1; }
        .hg-episode-grid { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 7px; padding: 11px 14px 14px; }
        .hg-episode { height: 32px; padding: 0; border-radius: 9px; background: var(--hg-hover-bg, rgba(127,127,127,.075)); font-size: 11px; }
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
        .hg-autoplay .hg-button { color: #fff; background: rgba(255,255,255,.16); }
        .hg-autoplay .hg-button.primary { background: #bb3e48; }
        @media (prefers-reduced-motion: reduce) {
          .hg-view { animation: none; }
          .hg-spinner { animation: none !important; }
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
