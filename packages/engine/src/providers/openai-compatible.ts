import type { GenerationRequest, GenerationResponse, ProviderCapability } from "../types.js";
import { BaseProviderAdapter } from "./base.js";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  apiStyle?: "responses" | "chat";
  capabilities: ProviderCapability[];
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export class OpenAiCompatibleProviderAdapter extends BaseProviderAdapter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers?: Record<string, string>;
  private readonly apiStyle: "responses" | "chat";

  public constructor(id: string, type: "openai" | "ollama" | "openai-compatible", model: string, options: OpenAiCompatibleOptions) {
    super(id, type, model, options.capabilities);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.apiStyle = options.apiStyle ?? "responses";
  }

  public async generateText(request: GenerationRequest): Promise<GenerationResponse> {
    if (this.apiStyle === "chat") {
      return this.generateViaChatCompletions(request);
    }
    return this.generateViaResponses(request);
  }

  private async generateViaResponses(request: GenerationRequest): Promise<GenerationResponse> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const input = encodedAttachments.length
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text: request.prompt },
              ...encodedAttachments.map((item) => ({
                type: "input_image",
                image_url: `data:${item.mimeType};base64,${item.base64}`
              }))
            ]
          }
        ]
      : request.prompt;

    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(this.apiKey),
        ...this.headers
      },
      body: JSON.stringify({
        model: this.model,
        input,
        instructions: request.system,
        max_output_tokens: request.maxOutputTokens
      })
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as { output_text?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    return {
      text: payload.output_text ?? "",
      usage: payload.usage ? { inputTokens: payload.usage.input_tokens, outputTokens: payload.usage.output_tokens } : undefined
    };
  }

  private async generateViaChatCompletions(request: GenerationRequest): Promise<GenerationResponse> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const content = encodedAttachments.length
      ? [
          { type: "text", text: request.prompt },
          ...encodedAttachments.map((item) => ({
            type: "image_url",
            image_url: {
              url: `data:${item.mimeType};base64,${item.base64}`
            }
          }))
        ]
      : request.prompt;

    const messages = [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content }];

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(this.apiKey),
        ...this.headers
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: request.maxOutputTokens
      })
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const contentValue = payload.choices?.[0]?.message?.content;
    const text = Array.isArray(contentValue) ? contentValue.map((item) => item.text ?? "").join("\n") : (contentValue ?? "");
    return {
      text,
      usage: payload.usage ? { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens } : undefined
    };
  }
}
