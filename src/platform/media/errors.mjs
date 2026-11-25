// 共享媒体层的错误类型：FFmpeg、直连 MP4、HLS 代理、字幕等模块抛出的错误都用它，
// code 是稳定的错误码，message 可直接展示给用户。卡片自己的错误类型可以继承它，
// 这样卡片把错误转成 RPC 回包时只需认 MediaError 一种。
export class MediaError extends Error {
  constructor(code, message, { status = null, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "MediaError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
