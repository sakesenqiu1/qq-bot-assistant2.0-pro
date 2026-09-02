/**
 * LLM 客户端：调用任意 OpenAI 兼容接口（DeepSeek / OpenAI / Moonshot / Ollama 等）。
 * 支持流式响应（SSE）与非流式 JSON 两种返回方式。
 */
export class LlmError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LlmError";
    this.status = options.status;
    this.cause = options.cause;
  }
}

export class LlmClient {
  constructor(options, logger) {
    this.baseUrl = String(options.baseUrl ?? "").replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? "";
    this.model = options.model ?? "";
    this.temperature = options.temperature ?? 0.9;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.logger = logger ?? null;
  }

  /**
   * 发送一轮对话。
   * @param {Array<{role:string, content:string}>} messages 完整消息列表（含 system）
   * @param {{signal?:AbortSignal, onToken?:(delta:string, full:string)=>void}} [opts]
   * @returns {Promise<string>} 完整回复文本
   */
  async chat(messages, { signal, onToken } = {}) {
    if (!this.baseUrl) throw new LlmError("未配置 llm.baseUrl");
    if (!this.model) throw new LlmError("未配置 llm.model");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const headers = { "Content-Type": "application/json" };
      if (this.apiKey) headers.Authorization = "Bearer " + this.apiKey;

      const res = await fetch(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {}
        throw new LlmError("HTTP " + res.status + (detail ? ": " + detail : ""), { status: res.status });
      }

      const contentType = res.headers.get("content-type") ?? "";

      // 部分服务忽略 stream 参数，直接返回完整 JSON —— 做兜底
      if (contentType.includes("application/json")) {
        const json = await res.json();
        const content = json.choices?.[0]?.message?.content ?? "";
        if (content) onToken?.(content, content);
        return content;
      }

      // SSE 流式解析
      if (!res.body) throw new LlmError("AI 服务返回了空响应体");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let content = "";
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = json.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            content += delta;
            onToken?.(delta, content);
          }
        }
      }
      return content;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err?.name === "AbortError") {
        if (signal?.aborted) throw new LlmError("已取消", { cause: err });
        throw new LlmError("AI 请求超时（超过 " + Math.round(this.timeoutMs / 1000) + " 秒）", { cause: err });
      }
      throw new LlmError(String(err?.message ?? err), { cause: err });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
