import type { GenerationRequest, GenerationResponse } from "../types.js";
import { firstSentences, normalizeWhitespace } from "../utils.js";
import { BaseProviderAdapter } from "./base.js";

function summarizePrompt(prompt: string): string {
  const cleaned = normalizeWhitespace(prompt);
  if (!cleaned) {
    return "No prompt content provided.";
  }
  return firstSentences(cleaned, 2) || cleaned.slice(0, 280);
}

export class HeuristicProviderAdapter extends BaseProviderAdapter {
  public constructor(id: string, model: string) {
    super(id, "heuristic", model, ["chat", "structured", "vision", "local"]);
  }

  public async generateText(request: GenerationRequest): Promise<GenerationResponse> {
    const attachmentHint = request.attachments?.length ? ` Attachments: ${request.attachments.length}.` : "";
    return {
      text: `Heuristic provider response.${attachmentHint} ${summarizePrompt(request.prompt)}`.trim()
    };
  }
}
