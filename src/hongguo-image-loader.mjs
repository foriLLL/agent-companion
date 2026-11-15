import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { resolveExternalMediaAddress } from "./emby-client.mjs";
import { HongguoError } from "./hongguo-sdk-client.mjs";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isHongguoImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (!url.port || url.port === "443")
      && ["byteimg.com", "fqnovelpic.com"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function unsafeImage(cause) {
  return new HongguoError("UNSAFE_IMAGE_URL", "拒绝加载非红果 CDN、本机或内网封面地址", { cause });
}

function requestImage(input, { signal, address, family }, requestImpl) {
  const url = new URL(input);
  return new Promise((resolve, reject) => {
    const request = requestImpl({
      protocol: "https:", hostname: address, family, port: 443, servername: url.hostname,
      path: `${url.pathname}${url.search}`, headers: { Host: url.host }, signal, agent: false
    }, response => {
      const headers = new Headers();
      for (const name of ["location", "content-type", "content-length"]) {
        const value = response.headers[name];
        if (value !== undefined) headers.set(name, String(value));
      }
      const status = response.statusCode ?? 0;
      resolve({ status, ok: status >= 200 && status < 300, headers, body: Readable.toWeb(response) });
    });
    request.once("error", reject);
    request.end();
  });
}

export class HongguoImageLoader {
  #dnsLookup;
  #fetch;
  #controller = new AbortController();

  constructor({ dnsLookup = lookup, fetchImpl = null, requestImpl = httpsRequest } = {}) {
    this.#dnsLookup = dnsLookup;
    this.#fetch = fetchImpl ?? ((url, options) => requestImage(url, options, requestImpl));
  }

  async load(input, { signal } = {}) {
    const requestSignal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    if (!isHongguoImageUrl(input)) throw unsafeImage();
    let url = new URL(input);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      requestSignal.throwIfAborted();
      if (!isHongguoImageUrl(url)) throw unsafeImage();
      let target;
      try {
        target = await resolveExternalMediaAddress(url.hostname, { dnsLookup: this.#dnsLookup });
      } catch (cause) {
        if (cause?.code === "UNSAFE_MEDIA_REDIRECT") throw unsafeImage(cause);
        throw new HongguoError("HONGGUO_NETWORK", "无法解析红果封面 CDN", { retryable: true, cause });
      }
      requestSignal.throwIfAborted();
      let response;
      try {
        response = await this.#fetch(url.href, { ...target, signal: requestSignal, redirect: "manual" });
      } catch (cause) {
        requestSignal.throwIfAborted();
        if (cause instanceof HongguoError) throw cause;
        if (cause?.cause instanceof HongguoError) throw cause.cause;
        throw new HongguoError("HONGGUO_NETWORK", "无法连接红果封面 CDN", { retryable: true, cause });
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === MAX_REDIRECTS) throw unsafeImage();
        try { url = new URL(location, url); } catch (cause) { throw unsafeImage(cause); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new HongguoError("IMAGE_HTTP_ERROR", `短剧封面加载失败（HTTP ${response.status}）`, {
          retryable: response.status === 408 || response.status === 429 || response.status >= 500
        });
      }
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        throw new HongguoError("IMAGE_TOO_LARGE", "短剧封面超过大小限制");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        requestSignal.throwIfAborted();
        size += chunk.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new HongguoError("IMAGE_TOO_LARGE", "短剧封面超过大小限制");
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks, size), contentType: response.headers.get("content-type") || "image/jpeg" };
    }
    throw unsafeImage();
  }

  dispose() {
    this.#controller.abort();
  }
}
