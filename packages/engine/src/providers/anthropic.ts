import type { GenerationRequest, GenerationResponse } from "../types.js";
import { BaseProviderAdapter } from "./base.js";

export class AnthropicProviderAdapter extends BaseProviderAdapter {
  private readonly apiKey?: string;
  private readonly headers?: Record<string, string>;
  private readonly baseUrl: string;

  public constructor(id: string, model: string, options: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string }) {
    super(id, "anthropic", model, ["chat", "structured", "tools", "vision", "streaming"]);
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  public async generateText(request: GenerationRequest): Promise<GenerationResponse> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const content = [
      { type: "text", text: request.prompt },
      ...encodedAttachments.map((item) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: item.mimeType,
          data: item.base64
        }
      }))
    ];

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        ...this.headers
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxOutputTokens ?? 1200,
        system: request.system,
        messages: [
          {
            role: "user",
            content
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    return {
      text:
        payload.content
          ?.filter((item) => item.type === "text")
          .map((item) => item.text ?? "")
          .join("\n") ?? "",
      usage: payload.usage ? { inputTokens: payload.usage.input_tokens, outputTokens: payload.usage.output_tokens } : undefined
    };
  }
}
