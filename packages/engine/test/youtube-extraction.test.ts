import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("youtube-transcript-plus", () => ({
  fetchTranscript: vi.fn()
}));

import { fetchTranscript } from "youtube-transcript-plus";
import { extractYoutubeTranscript } from "../src/extraction.js";

const mockFetchTranscript = vi.mocked(fetchTranscript);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractYoutubeTranscript", () => {
  it("returns formatted markdown with transcript and metadata", async () => {
    const transcript = {
      videoDetails: {
        videoId: "dQw4w9WgXcQ",
        title: "Test Video",
        author: "Test Author",
        channelId: "UC123",
        lengthSeconds: 300,
        viewCount: 1000,
        description: "A test video",
        keywords: [],
        thumbnails: [],
        isLiveContent: false
      },
      segments: [
        { text: "Hello world.", offset: 0, duration: 2, lang: "en" },
        { text: "This is a test.", offset: 2, duration: 3, lang: "en" }
      ]
    };
    mockFetchTranscript.mockResolvedValue(transcript as unknown as never);

    const result = await extractYoutubeTranscript({
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    });

    expect(result.title).toBe("Test Video");
    expect(result.extractedText).toContain("# Test Video");
    expect(result.extractedText).toContain("Test Author");
    expect(result.extractedText).toContain("5:00");
    expect(result.extractedText).toContain("Hello world.");
    expect(result.extractedText).toContain("This is a test.");
    expect(result.artifact.extractor).toBe("youtube_transcript");
    expect(result.artifact.sourceKind).toBe("youtube");
    expect(result.artifact.metadata?.author).toBe("Test Author");
    expect(result.artifact.metadata?.duration).toBe("300");
  });

  it("returns warning when transcript fetch fails", async () => {
    mockFetchTranscript.mockRejectedValue(new Error("Subtitles are disabled for this video"));

    const result = await extractYoutubeTranscript({
      videoId: "invalid123",
      url: "https://www.youtube.com/watch?v=invalid123"
    });

    expect(result.extractedText).toBeUndefined();
    expect(result.artifact.warnings).toBeDefined();
    expect(result.artifact.warnings![0]).toContain("disabled");
  });
});
