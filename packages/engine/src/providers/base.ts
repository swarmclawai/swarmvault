import fs from "node:fs/promises";
import { z } from "zod";
import type {
  GenerationAttachment,
  GenerationRequest,
  GenerationResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ProviderAdapter,
  ProviderCapability,
  ProviderType
} from "../types.js";
import { extractJson } from "../utils.js";

export abstract class BaseProviderAdapter implements ProviderAdapter {
  public readonly capabilities: Set<ProviderCapability>;

  public constructor(
    public readonly id: string,
    public readonly type: ProviderType,
    public readonly model: string,
    capabilities: ProviderCapability[]
  ) {
    this.capabilities = new Set(capabilities);
  }

  public abstract generateText(request: GenerationRequest): Promise<GenerationResponse>;

  public async embedTexts(_texts: string[]): Promise<number[][]> {
    throw new Error(`Provider ${this.id} does not support embeddings.`);
  }

  public async generateImage(_request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    throw new Error(`Provider ${this.id} does not support image generation.`);
  }

  public async generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> {
    const schemaDescription = JSON.stringify(z.toJSONSchema(schema), null, 2);
    const response = await this.generateText({
      ...request,
      prompt: `${request.prompt}\n\nReturn JSON only. Follow this JSON Schema exactly:\n${schemaDescription}`
    });
    const parsed = JSON.parse(extractJson(response.text));
    return schema.parse(parsed);
  }

  protected async encodeAttachments(attachments: GenerationAttachment[] = []): Promise<Array<{ mimeType: string; base64: string }>> {
    return Promise.all(
      attachments.map(async (attachment) => ({
        mimeType: attachment.mimeType,
        base64: await fs.readFile(attachment.filePath, "base64")
      }))
    );
  }
}
