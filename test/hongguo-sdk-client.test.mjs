import assert from "node:assert/strict";
import test from "node:test";
import { HongguoSdkClient } from "../cards/hongguo/hongguo-sdk-client.mjs";

test("discover 将频道与上游游标传给 SDK，不伪造 pageSize", async () => {
  const calls = [];
  const client = new HongguoSdkClient({ createClientImpl: async () => ({ discover: async options => { calls.push(options); return { items: [], has_more: false }; } }) });
  await client.discover();
  await client.discover({ cursor: "next", channel: "comic" });
  assert.deepEqual(calls, [{ cursor: "" }, { cursor: "next", channel: "comic" }]);
});

test("搜索默认限定剧集并保留分页游标，批量详情与季接口使用真实 SDK 方法", async () => {
  const calls = [];
  const client = new HongguoSdkClient({ createClientImpl: async () => ({
    search: async (...args) => { calls.push(["search", ...args]); return { items: [], has_more: false }; },
    getSeriesBatch: async ids => { calls.push(["getSeriesBatch", ids]); return []; },
    seasons: async id => { calls.push(["seasons", id]); return { seasons: [] }; }
  }) });
  await client.search("持械入宋");
  await client.search("持械入宋", { cursor: "20", pageSize: 10 });
  await client.getSeriesBatch([100, "200"]);
  await client.seasons(100);
  assert.deepEqual(calls, [
    ["search", "持械入宋", { cursor: "", pageSize: 20, tab: "剧集" }],
    ["search", "持械入宋", { cursor: "20", pageSize: 10, tab: "剧集" }],
    ["getSeriesBatch", ["100", "200"]],
    ["seasons", "100"]
  ]);
});

test("匿名空结果按实际接口说明，推荐错误不误报播放失败或虚构已换设备", async () => {
  const empty = async () => { throw Object.assign(new Error("empty"), { code: "ANONYMOUS_LIMITED", retryable: false }); };
  const client = new HongguoSdkClient({ createClientImpl: async () => ({ discover: empty, listEpisodes: empty, resolvePlayback: empty }) });
  await assert.rejects(client.discover(), error => error.code === "HONGGUO_LIMITED" && !error.retryable && /推荐内容/.test(error.message) && !/播放地址|已自动/.test(error.message));
  await assert.rejects(client.listEpisodes("100"), error => /分集列表/.test(error.message) && !/已自动/.test(error.message));
  await assert.rejects(client.resolvePlayback("201"), error => /这一集的播放地址/.test(error.message) && !/已自动/.test(error.message));
});
