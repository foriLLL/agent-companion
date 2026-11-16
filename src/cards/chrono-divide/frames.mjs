import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { registerMediaInterceptPort, toMediaInterceptUrl } from "../../media-intercept.mjs";

// 复用 Companion 的受限媒体入口。Chromium 直接把 JPEG 解码到卡片，不等音视频同步或重传。
export async function createFrameFeed({ browser, sessionId, send, setVideoEnabled, initialSize }) {
  const path = `/hls/${randomUUID()}/battle.mjpeg`;
  const boundary = "companion-frame";
  const separator = Buffer.from(`\r\n--${boundary}\r\n`);
  let client, latest, captureSize, size = initialSize, closed = false;
  let updates = Promise.resolve(), closing;

  function flush() {
    if (!latest || !client || client.writableNeedDrain) return;
    const data = Buffer.from(latest, "base64");
    latest = null;
    // 即刻写出下一帧的边界。即使画面静止，浏览器也能立即显示这一帧。
    client.write(Buffer.concat([Buffer.from(`Content-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`), data, separator]));
  }
  const unsubscribe = browser.onFrame(sessionId, frame => {
    void send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    if (client) { latest = frame.data; flush(); }
  });

  function sync() {
    updates = updates.then(async () => {
      const next = !closed && client ? size : null;
      if (captureSize?.width === next?.width && captureSize?.height === next?.height) return;
      if (captureSize) {
        await send("Page.stopScreencast");
        captureSize = null;
      }
      if (next) {
        await send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: next.width, maxHeight: next.height });
        captureSize = next;
        await setVideoEnabled(false);
      } else if (!closed) await setVideoEnabled(true);
    }).catch(() => {
      client?.destroy();
      if (!closed) return setVideoEnabled(true).catch(() => {});
    });
    return updates;
  }
  const server = createServer((req, res) => {
    if (closed || req.method !== "GET" || req.url !== path || req.headers.host !== `127.0.0.1:${server.address().port}`) {
      res.writeHead(404).end();
      return;
    }
    client?.destroy();
    client = res;
    latest = null;
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`, "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin"
    });
    res.write(`--${boundary}\r\n`);
    res.on("drain", flush);
    res.on("close", () => {
      if (client !== res) return;
      client = latest = null;
      void sync();
    });
    void sync();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) { unsubscribe(); throw error; }
  const { port } = server.address();
  const unregister = registerMediaInterceptPort(port);
  return {
    url: toMediaInterceptUrl(`http://127.0.0.1:${port}${path}`),
    resize(next) { size = next; return sync(); },
    close() {
      if (closing) return closing;
      closed = true;
      unregister();
      client?.destroy();
      server.close();
      server.closeAllConnections();
      closing = sync().finally(unsubscribe);
      return closing;
    }
  };
}
