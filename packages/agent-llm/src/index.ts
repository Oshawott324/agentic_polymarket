import { ProxyAgent, setGlobalDispatcher } from "undici";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmClientOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
};

function stripThinkTags(content: string) {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function stripMarkdownCodeFences(content: string) {
  const trimmed = content.trim();
  const withoutStart = trimmed.replace(/^```(?:json)?\s*/i, "");
  return withoutStart.replace(/\s*```$/, "").trim();
}

function parseJsonContent<T>(content: string): T {
  const cleaned = stripMarkdownCodeFences(stripThinkTags(content));

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error(`invalid_llm_json_response:${cleaned}`);
  }
}

export class LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 1_500;
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetriableStatus(status: number) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  private isRetriableError(error: unknown) {
    const text = String(error ?? "");
    return (
      text.includes("fetch failed") ||
      text.includes("AbortError") ||
      text.includes("ETIMEDOUT") ||
      text.includes("ECONNRESET") ||
      text.includes("ECONNREFUSED") ||
      text.includes("ENOTFOUND") ||
      text.includes("EAI_AGAIN")
    );
  }

  async chat(messages: LlmMessage[]) {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`llm_request_failed:${response.status}:${text}`);
          if (attempt < this.maxRetries && this.isRetriableStatus(response.status)) {
            lastError = error;
            await this.sleep(this.retryBackoffMs * (attempt + 1));
            continue;
          }
          throw error;
        }

        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim().length === 0) {
          throw new Error("llm_response_content_missing");
        }
        return content;
      } catch (error) {
        if (attempt < this.maxRetries && this.isRetriableError(error)) {
          lastError = error;
          await this.sleep(this.retryBackoffMs * (attempt + 1));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error("llm_request_failed");
  }

  async chatJson<T>(messages: LlmMessage[]) {
    const content = await this.chat(messages);
    return parseJsonContent<T>(content);
  }
}

export function loadLlmClientFromEnv() {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required when LLM mode is enabled");
  }

  const proxyUrl =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy;
  if (proxyUrl) {
    try {
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
    } catch (error) {
      throw new Error(`LLM proxy configuration failed: ${String(error)}`);
    }
  }

  return new LlmClient({
    apiKey,
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.LLM_MODEL_NAME ?? "gpt-4o-mini",
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.4),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 4096),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 60_000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES ?? 2),
    retryBackoffMs: Number(process.env.LLM_RETRY_BACKOFF_MS ?? 1_500),
  });
}
