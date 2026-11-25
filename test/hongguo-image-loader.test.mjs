import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HongguoImageLoader } from "../cards/hongguo/hongguo-image-loader.mjs";

const COVER = "https://p6-novel.byteimg.com/novel-pic/abc.image";
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

test("封面加载拒绝任意域名、HTTP、凭证、异常端口及 CDN 域名伪装", async testContext => {
  let requests = 0;
  const loader = new HongguoImageLoader({ dnsLookup: publicDns, fetchImpl: async () => { requests += 1; return new Response(); } });
  testContext.after(() => loader.dispose());
  for (const url of ["bad-url", "http://127.0.0.1/private", "https://evil.example/image", "https://byteimg.com.evil.example/image", "https://user:pass@p6-novel.byteimg.com/image", "https://p6-novel.byteimg.com:8080/image"]) {
    await assert.rejects(loader.load(url), { code: "UNSAFE_IMAGE_URL" });
  }
  assert.equal(requests, 0);
});

test("CDN 域名解析到私网或包含私网记录时，发送 HTTP 请求前即拒绝", async testContext => {
  let requests = 0;
  for (const addresses of [["127.0.0.1"], ["10.0.0.1"], ["169.254.169.254"], ["::1"], ["93.184.216.34", "192.168.1.2"]]) {
    const loader = new HongguoImageLoader({
      dnsLookup: async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 })),
      fetchImpl: async () => { requests += 1; return new Response(); }
    });
    testContext.after(() => loader.dispose());
    await assert.rejects(loader.load(COVER), { code: "UNSAFE_IMAGE_URL" });
  }
  assert.equal(requests, 0);
});

test("每跳重定向单独验证，不能访问本机或非 CDN 目标", async testContext => {
  for (const location of ["http://127.0.0.1/private", "https://evil.example/private", "https://p3-novel.byteimg.com/private"]) {
    const requests = [];
    const loader = new HongguoImageLoader({
      dnsLookup: async hostname => hostname.startsWith("p3-") ? [{ address: "10.0.0.1", family: 4 }] : publicDns(),
      fetchImpl: async (url, options) => {
        requests.push(url);
        assert.equal(options.redirect, "manual");
        return new Response(null, { status: 302, headers: { location } });
      }
    });
    testContext.after(() => loader.dispose());
    await assert.rejects(loader.load(COVER), { code: "UNSAFE_IMAGE_URL" });
    assert.deepEqual(requests, [COVER]);
  }
});

test("HTTPS 连接固定已验证的 IP，不再次解析可能重绑定的 CDN 域名", async testContext => {
  let lookups = 0;
  let connection;
  const loader = new HongguoImageLoader({
    dnsLookup: async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }],
    requestImpl: (options, callback) => {
      connection = options;
      const request = new EventEmitter();
      request.end = () => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { "content-type": "image/jpeg" };
        callback(response);
        response.end(new Uint8Array([1, 2, 3]));
      };
      return request;
    }
  });
  testContext.after(() => loader.dispose());
  const image = await loader.load(COVER);
  assert.deepEqual([...image.bytes], [1, 2, 3]);
  assert.equal(lookups, 1);
  assert.equal(connection.hostname, "93.184.216.34");
  assert.equal(connection.servername, "p6-novel.byteimg.com");
  assert.equal(connection.headers.Host, "p6-novel.byteimg.com");
});

test("安全 CDN 重定向可返回图片字节", async testContext => {
  const requests = [];
  const loader = new HongguoImageLoader({
    dnsLookup: publicDns,
    fetchImpl: async url => {
      requests.push(url);
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: "/novel-pic/final.image" } })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    }
  });
  testContext.after(() => loader.dispose());
  const image = await loader.load(COVER);
  assert.deepEqual([...image.bytes], [1, 2, 3]);
  assert.equal(image.contentType, "image/jpeg");
  assert.equal(requests.length, 2);
});

test("流式读取在超过大小上限时取消响应，不先下载完整大文件", async testContext => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024)); },
    cancel() { cancelled = true; }
  });
  const loader = new HongguoImageLoader({ dnsLookup: publicDns, fetchImpl: async () => new Response(body) });
  testContext.after(() => loader.dispose());
  await assert.rejects(loader.load(COVER), { code: "IMAGE_TOO_LARGE" });
  assert.equal(cancelled, true);
});

test("连接前的临时 DNS 失败仍可重试，不误报为不安全封面", async testContext => {
  const loader = new HongguoImageLoader({ dnsLookup: async () => {
    throw new Error("DNS 暂不可用");
  } });
  testContext.after(() => loader.dispose());
  await assert.rejects(loader.load(COVER), { code: "HONGGUO_NETWORK", retryable: true });
});
