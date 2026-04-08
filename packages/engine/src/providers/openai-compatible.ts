import { z } from "zod";
import type {
  GenerationRequest,
  GenerationResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ProviderCapability,
  ProviderType
} from "../types.js";
import { extractJson } from "../utils.js";
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

type ResponsesApiPayload = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type JsonSchema = Record<string, unknown>;

function extractResponsesText(payload: ResponsesApiPayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  return (
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("\n")
      .trim() ?? ""
  );
}

function isJsonSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowNullInSchema(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  }

  if (typeof schema.type === "string") {
    return schema.type === "null" ? schema : { ...schema, type: [schema.type, "null"] };
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(null) ? schema : { ...schema, enum: [...schema.enum, null] };
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((item) => isJsonSchemaObject(item) && item.type === "null")
      ? schema
      : { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
  }

  return { anyOf: [schema, { type: "null" }] };
}

function toOpenAiStrictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => toOpenAiStrictJsonSchema(item));
  }

  if (!isJsonSchemaObject(schema)) {
    return schema;
  }

  const normalizedEntries = Object.entries(schema)
    .filter(([key]) => key !== "$schema")
    .map(([key, value]) => [key, toOpenAiStrictJsonSchema(value)]);
  const normalizedSchema = Object.fromEntries(normalizedEntries) as JsonSchema;

  if (isJsonSchemaObject(normalizedSchema.properties)) {
    const properties = normalizedSchema.properties as Record<string, unknown>;
    const originalRequired = Array.isArray(normalizedSchema.required)
      ? normalizedSchema.required.filter((item): item is string => typeof item === "string")
      : [];
    const requiredSet = new Set(originalRequired);
    const propertyEntries = Object.entries(properties).map(([key, value]) => {
      const normalizedProperty = isJsonSchemaObject(value) ? value : {};
      return [key, requiredSet.has(key) ? normalizedProperty : allowNullInSchema(normalizedProperty)];
    });
    return {
      ...normalizedSchema,
      properties: Object.fromEntries(propertyEntries),
      required: Object.keys(properties),
      additionalProperties: false
    };
  }

  return normalizedSchema;
}

function stripNullObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripNullObjectProperties(item));
  }

  if (!isJsonSchemaObject(value)) {
    return value;
  }

  const entries = Object.entries(value)
    .filter(([, item]) => item !== null)
    .map(([key, item]) => [key, stripNullObjectProperties(item)]);
  return Object.fromEntries(entries);
}

function buildStructuredFormat(schema: z.ZodTypeAny) {
  return {
    type: "json_schema" as const,
    name: "swarmvault_response",
    schema: toOpenAiStrictJsonSchema(z.toJSONSchema(schema)),
    strict: true
  };
}

export class OpenAiCompatibleProviderAdapter extends BaseProviderAdapter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers?: Record<string, string>;
  private readonly apiStyle: "responses" | "chat";

  public constructor(id: string, type: ProviderType, model: string, options: OpenAiCompatibleOptions) {
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

  public async generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> {
    if (this.type !== "openai") {
      return super.generateStructured(request, schema);
    }

    const structuredFormat = buildStructuredFormat(schema);
    const text =
      this.apiStyle === "chat"
        ? await this.generateStructuredViaChatCompletions(
            {
              ...request
            },
            structuredFormat
          )
        : await this.generateStructuredViaResponses(
            {
              ...request
            },
            structuredFormat
          );

    return schema.parse(stripNullObjectProperties(JSON.parse(extractJson(text))));
  }

  public async embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(this.apiKey),
        ...this.headers
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vectors = payload.data?.map((item) => item.embedding ?? []) ?? [];
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
      throw new Error(`Provider ${this.id} returned invalid embedding data.`);
    }
    return vectors;
  }

  public async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(this.apiKey),
        ...this.headers
      },
      body: JSON.stringify({
        model: this.model,
        prompt: request.prompt,
        size:
          request.width && request.height
            ? `${Math.max(256, Math.round(request.width))}x${Math.max(256, Math.round(request.height))}`
            : undefined,
        response_format: "b64_json",
        ...(encodedAttachments.length
          ? {
              input_image: encodedAttachments.map((item) => `data:${item.mimeType};base64,${item.base64}`)
            }
          : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    };
    const image = payload.data?.[0];
    if (!image?.b64_json) {
      throw new Error(`Provider ${this.id} returned no image data.`);
    }

    return {
      mimeType: "image/png",
      bytes: Buffer.from(image.b64_json, "base64"),
      width: request.width,
      height: request.height,
      revisedPrompt: image.revised_prompt
    };
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

    const payload = (await response.json()) as ResponsesApiPayload;
    return {
      text: extractResponsesText(payload),
      usage: payload.usage ? { inputTokens: payload.usage.input_tokens, outputTokens: payload.usage.output_tokens } : undefined
    };
  }

  private async generateStructuredViaResponses(
    request: GenerationRequest,
    format: ReturnType<typeof buildStructuredFormat>
  ): Promise<string> {
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
        max_output_tokens: request.maxOutputTokens,
        text: {
          format
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as ResponsesApiPayload;
    return extractResponsesText(payload);
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

  private async generateStructuredViaChatCompletions(
    request: GenerationRequest,
    format: ReturnType<typeof buildStructuredFormat>
  ): Promise<string> {
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
        max_tokens: request.maxOutputTokens,
        response_format: {
          type: "json_schema",
          json_schema: format
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const contentValue = payload.choices?.[0]?.message?.content;
    return Array.isArray(contentValue) ? contentValue.map((item) => item.text ?? "").join("\n") : (contentValue ?? "");
  }
}
