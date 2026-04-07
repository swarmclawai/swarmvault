import type { GenerationRequest, GenerationResponse } from "../types.js";
import { BaseProviderAdapter } from "./base.js";

export class GeminiProviderAdapter extends BaseProviderAdapter {
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  public constructor(id: string, model: string, options: { apiKey?: string; baseUrl?: string }) {
    super(id, "gemini", model, ["chat", "structured", "vision", "tools", "streaming"]);
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  }

  public async generateText(request: GenerationRequest): Promise<GenerationResponse> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const parts = [
      ...(request.system ? [{ text: `System instructions:\n${request.system}` }] : []),
      { text: request.prompt },
      ...encodedAttachments.map((item) => ({
        inline_data: {
          mime_type: item.mimeType,
          data: item.base64
        }
      }))
    ];

    const response = await fetch(`${this.baseUrl}/models/${this.model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "x-goog-api-key": this.apiKey } : {})
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts
          }
        ],
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens ?? 1200
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    return {
      text,
      usage: payload.usageMetadata
        ? { inputTokens: payload.usageMetadata.promptTokenCount, outputTokens: payload.usageMetadata.candidatesTokenCount }
        : undefined
    };
  }
}
