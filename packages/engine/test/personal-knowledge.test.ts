import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptApproval,
  addManagedSource,
  compileVault,
  guideManagedSource,
  ingestDirectory,
  initVault,
  readApproval,
  resumeSourceSession,
  reviewManagedSource
} from "../src/index.js";
import type { SourceManifest } from "../src/types.js";

const tempDirs: string[] = [];
const GUIDE_ANSWERS = {
  importance: "Focus on the source-backed changes that should inform the durable research notes.",
  exclude: "Leave speculative conclusions out until they are reinforced by more than one source.",
  targets: "Update the transcript notes and the main research summary.",
  conflicts: "Call out anything that changes the current summary or conflicts with the existing thesis.",
  followups: "Keep the next source and contradiction review questions visible."
};

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-personal-"));
  tempDirs.push(dir);
  return dir;
}

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function readManifests(rootDir: string): Promise<SourceManifest[]> {
  const manifestsDir = path.join(rootDir, "state", "manifests");
  const names = await fs.readdir(manifestsDir);
  return await Promise.all(
    names.map(async (name) => JSON.parse(await fs.readFile(path.join(manifestsDir, name), "utf8")) as SourceManifest)
  );
}

function createMbox(): string {
  return [
    "From alice@example.com Tue Apr 09 10:00:00 2026",
    "From: Alice <alice@example.com>",
    "To: Bob <bob@example.com>",
    "Subject: Kickoff",
    "Date: Thu, 09 Apr 2026 10:00:00 +0000",
    "Message-ID: <kickoff@example.com>",
    "",
    "Kickoff notes should stay searchable.",
    "",
    "From bob@example.com Thu Apr 09 11:00:00 2026",
    "From: Bob <bob@example.com>",
    "To: Alice <alice@example.com>",
    "Subject: Follow up",
    "Date: Thu, 09 Apr 2026 11:00:00 +0000",
    "Message-ID: <follow-up@example.com>",
    "In-Reply-To: <kickoff@example.com>",
    "",
    "Following up after the kickoff.",
    ""
  ].join("\n");
}

function createIcs(): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SwarmVault Tests//EN",
    "BEGIN:VEVENT",
    "UID:event-1",
    "DTSTAMP:20260409T090000Z",
    "DTSTART:20260409T100000Z",
    "DTEND:20260409T103000Z",
    "SUMMARY:Research Sync",
    "DESCRIPTION:Discuss the new ingest adapters.",
    "LOCATION:Zoom",
    "ORGANIZER;CN=Wayde:mailto:wayde@example.com",
    "ATTENDEE;CN=Alex:mailto:alex@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].join("\n");
}

function createSlackExportZip(): Buffer {
  return Buffer.from(
    zipSync({
      "users.json": Buffer.from(
        JSON.stringify([
          { id: "U1", name: "wayde", real_name: "Wayde" },
          { id: "U2", name: "alex", real_name: "Alex" }
        ]),
        "utf8"
      ),
      "channels.json": Buffer.from(JSON.stringify([{ id: "C1", name: "general", members: ["U1", "U2"] }]), "utf8"),
      "general/2026-04-09.json": Buffer.from(
        JSON.stringify([
          { type: "message", user: "U1", text: "We should compile the wiki after every important source.", ts: "1775728800.000100" },
          {
            type: "message",
            user: "U2",
            text: "Agreed, and keep the review staged.",
            ts: "1775729100.000200",
            thread_ts: "1775728800.000100"
          }
        ]),
        "utf8"
      )
    })
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await removeDirWithRetry(dir)));
});

describe("personal knowledge workflows", () => {
  it("initializes a personal-research profile with guided-ingest and deep-lint starter defaults", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir, { profile: "personal-research" });

    const config = JSON.parse(await fs.readFile(path.join(rootDir, "swarmvault.config.json"), "utf8")) as {
      profile?: {
        presets?: string[];
        dashboardPack?: string;
        guidedSessionMode?: string;
        dataviewBlocks?: boolean;
        guidedIngestDefault?: boolean;
        deepLintDefault?: boolean;
      };
    };
    expect(config.profile?.presets).toEqual(["reader", "timeline", "thesis"]);
    expect(config.profile?.dashboardPack).toBe("reader");
    expect(config.profile?.guidedSessionMode).toBe("canonical_review");
    expect(config.profile?.dataviewBlocks).toBe(true);
    expect(config.profile?.guidedIngestDefault).toBe(true);
    expect(config.profile?.deepLintDefault).toBe(true);

    const schema = await fs.readFile(path.join(rootDir, "swarmvault.schema.md"), "utf8");
    expect(schema).toContain("one-source-at-a-time guided ingest");
    expect(schema).toContain("thesis");
    expect(schema).toContain("Profile Emphasis");

    const insightsIndex = await fs.readFile(path.join(rootDir, "wiki", "insights", "index.md"), "utf8");
    expect(insightsIndex).toContain("research notes");
    expect(insightsIndex).toContain("human judgment layer");
    expect(insightsIndex).toContain("canonical pages");

    const playbook = await fs.readFile(path.join(rootDir, "wiki", "insights", "research-playbook.md"), "utf8");
    expect(playbook).toContain("swarmvault ingest <input> --guide");
    expect(playbook).toContain("wiki/outputs/source-sessions/");
    expect(playbook).toContain("Active profile presets");
  });

  it("supports composed profile presets, dataview dashboards, and explicit lint defaults", async () => {
    const rootDir = await createTempWorkspace();
    const researchDir = path.join(rootDir, "research");
    await fs.mkdir(researchDir, { recursive: true });
    await fs.writeFile(path.join(researchDir, "notes.srt"), ["1", "00:00:01,000 --> 00:00:03,000", "Profile preset test.", ""].join("\n"));

    await initVault(rootDir, { profile: "reader,timeline" });
    const config = JSON.parse(await fs.readFile(path.join(rootDir, "swarmvault.config.json"), "utf8")) as {
      profile?: {
        presets?: string[];
        dashboardPack?: string;
        guidedSessionMode?: string;
        dataviewBlocks?: boolean;
        guidedIngestDefault?: boolean;
        deepLintDefault?: boolean;
      };
    };
    expect(config.profile?.presets).toEqual(["reader", "timeline"]);
    expect(config.profile?.dashboardPack).toBe("reader");
    expect(config.profile?.guidedSessionMode).toBe("canonical_review");
    expect(config.profile?.dataviewBlocks).toBe(true);
    expect(config.profile?.guidedIngestDefault).toBe(false);
    expect(config.profile?.deepLintDefault).toBe(false);

    await ingestDirectory(rootDir, researchDir, { repoRoot: researchDir });
    await compileVault(rootDir);

    const dashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "index.md"), "utf8");
    expect(dashboard).toContain("```dataview");
    expect(dashboard).toContain("profile_presets:");
  });

  it("extracts human export sources and generates dashboards", async () => {
    const rootDir = await createTempWorkspace();
    const researchDir = path.join(rootDir, "research");
    await fs.mkdir(researchDir, { recursive: true });
    await fs.writeFile(
      path.join(researchDir, "call.srt"),
      ["1", "00:00:01,000 --> 00:00:03,000", "Kickoff transcript line.", ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(researchDir, "message.eml"),
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Research direction",
        "Date: Thu, 09 Apr 2026 12:00:00 +0000",
        "Message-ID: <message@example.com>",
        "",
        "This message should appear in the personal knowledge dashboards.",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(researchDir, "calendar.ics"), createIcs(), "utf8");
    await fs.writeFile(path.join(researchDir, "mailbox.mbox"), createMbox(), "utf8");
    await fs.writeFile(path.join(researchDir, "slack-export.zip"), createSlackExportZip());

    await initVault(rootDir);
    await ingestDirectory(rootDir, researchDir, { repoRoot: researchDir });
    await compileVault(rootDir);

    const manifests = await readManifests(rootDir);
    expect(manifests.some((manifest) => manifest.sourceKind === "transcript")).toBe(true);
    expect(manifests.some((manifest) => manifest.sourceKind === "email" && manifest.originalPath?.endsWith("message.eml"))).toBe(true);
    expect(manifests.some((manifest) => manifest.sourceKind === "calendar")).toBe(true);
    expect(manifests.some((manifest) => manifest.sourceKind === "chat_export")).toBe(true);

    const mailboxMessages = manifests.filter((manifest) => manifest.originalPath?.endsWith("mailbox.mbox"));
    expect(mailboxMessages).toHaveLength(2);
    expect(mailboxMessages.every((manifest) => manifest.sourceGroupTitle === "mailbox")).toBe(true);

    const slackManifest = manifests.find((manifest) => manifest.sourceKind === "chat_export");
    expect(slackManifest?.details?.channel).toBe("general");
    expect(slackManifest?.details?.participants).toContain("Wayde");
    expect(slackManifest?.details?.conversation_id).toBeTruthy();

    const emailManifest = manifests.find((manifest) => manifest.originalPath?.endsWith("message.eml"));
    const emailPage = await fs.readFile(path.join(rootDir, "wiki", "sources", `${emailManifest?.sourceId}.md`), "utf8");
    const emailPageMatter = matter(emailPage);
    expect(emailPageMatter.data.title).toBe("Research direction");
    expect(emailPage).toContain("# Research direction");
    expect(emailPage).not.toContain("# Research direction Date:");
    expect(emailPage).toContain("occurred_at:");
    expect(emailPage).toContain("participants:");
    expect(emailPage).toContain("conversation_id:");

    const transcriptManifest = manifests.find((manifest) => manifest.sourceKind === "transcript");
    const transcriptPage = await fs.readFile(path.join(rootDir, "wiki", "sources", `${transcriptManifest?.sourceId}.md`), "utf8");
    const transcriptPageMatter = matter(transcriptPage);
    expect(transcriptPageMatter.data.title).toBe("call");
    expect(transcriptPage).toContain("# call");
    expect(transcriptPage).not.toContain("# call Format:");

    const timelineDashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "timeline.md"), "utf8");
    expect(timelineDashboard).toContain("Research Sync");
    const recentSourcesDashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "recent-sources.md"), "utf8");
    expect(recentSourcesDashboard).toContain("Research direction");
    expect(recentSourcesDashboard).not.toContain("```dataview");
    const readingLogDashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "reading-log.md"), "utf8");
    expect(readingLogDashboard).toContain("Research Sync");
    const sourceGuidesDashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "source-guides.md"), "utf8");
    expect(sourceGuidesDashboard).toContain("# Source Guides");
    const researchMapDashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "research-map.md"), "utf8");
    expect(researchMapDashboard).toContain("# Research Map");
    const openQuestionsDashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "open-questions.md"), "utf8");
    expect(openQuestionsDashboard).toContain("# Open Questions");
  });

  it("registers managed file sources and stages source reviews", async () => {
    const rootDir = await createTempWorkspace();
    const transcriptPath = path.join(rootDir, "call.srt");
    await fs.writeFile(transcriptPath, ["1", "00:00:01,000 --> 00:00:02,000", "Review this transcript.", ""].join("\n"), "utf8");

    await initVault(rootDir);
    const added = await addManagedSource(rootDir, transcriptPath, { review: true });
    expect(added.source.kind).toBe("file");
    expect(added.source.sourceIds.length).toBe(1);
    expect(added.review?.approvalId).toBeTruthy();
    await fs.access(added.review?.reviewPath ?? "");

    const detail = await readApproval(rootDir, added.review?.approvalId ?? "");
    expect(detail.entries.some((entry) => entry.nextPath === `outputs/source-reviews/${added.source.id}.md`)).toBe(true);
    const managedReviewEntry = detail.entries.find((entry) => entry.nextPath === `outputs/source-reviews/${added.source.id}.md`);
    expect(matter(managedReviewEntry?.stagedContent ?? "").data.origin).toBe("source_review");

    const rawSourceReview = await reviewManagedSource(rootDir, added.source.sourceIds[0]!);
    expect(rawSourceReview.approvalId).toBeTruthy();
    await fs.access(rawSourceReview.reviewPath);
    const rawDetail = await readApproval(rootDir, rawSourceReview.approvalId ?? "");
    expect(rawDetail.entries.some((entry) => entry.nextPath === `outputs/source-reviews/${added.source.sourceIds[0]}.md`)).toBe(true);
    const rawReviewEntry = rawDetail.entries.find((entry) => entry.nextPath === `outputs/source-reviews/${added.source.sourceIds[0]}.md`);
    expect(matter(rawReviewEntry?.stagedContent ?? "").data.origin).toBe("source_review");
  });

  it("creates resumable guided sessions that stage canonical updates through approvals", async () => {
    const rootDir = await createTempWorkspace();
    const transcriptPath = path.join(rootDir, "call.srt");
    await fs.writeFile(
      transcriptPath,
      ["1", "00:00:01,000 --> 00:00:02,000", "Guide this transcript into the wiki.", ""].join("\n"),
      "utf8"
    );

    await initVault(rootDir, { profile: "personal-research" });
    const awaiting = await addManagedSource(rootDir, transcriptPath, { guide: true });
    expect(awaiting.guide?.awaitingInput).toBe(true);
    expect(awaiting.guide?.approvalId).toBeUndefined();
    await fs.access(awaiting.guide?.sessionPath ?? "");

    const added = await resumeSourceSession(rootDir, awaiting.guide?.sessionId ?? "", { answers: GUIDE_ANSWERS });
    expect(awaiting.source.kind).toBe("file");
    expect(added.approvalId).toBeTruthy();
    await fs.access(added.guidePath ?? "");
    await fs.access(added.reviewPath ?? "");
    await fs.access(added.briefPath ?? "");
    await fs.access(added.sessionPath ?? "");

    const detail = await readApproval(rootDir, added.approvalId ?? "");
    expect(detail.bundleType).toBe("guided_session");
    expect(detail.title).toContain("Guided Session");
    expect(detail.sourceSessionId).toBe(added.sessionId);
    expect(detail.entries.some((entry) => entry.label === "source-review")).toBe(true);
    expect(detail.entries.some((entry) => entry.label === "source-guide")).toBe(true);
    expect(detail.entries.some((entry) => entry.label === "guided-update")).toBe(true);
    expect(detail.entries.some((entry) => entry.nextPath === `outputs/source-guides/${awaiting.source.id}.md`)).toBe(true);
    expect(detail.entries.some((entry) => entry.nextPath === `outputs/source-reviews/${awaiting.source.id}.md`)).toBe(true);
    const sourceGuideEntry = detail.entries.find((entry) => entry.nextPath === `outputs/source-guides/${awaiting.source.id}.md`);
    const sourceReviewEntry = detail.entries.find((entry) => entry.nextPath === `outputs/source-reviews/${awaiting.source.id}.md`);
    expect(matter(sourceGuideEntry?.stagedContent ?? "").data.origin).toBe("source_guide");
    expect(matter(sourceReviewEntry?.stagedContent ?? "").data.origin).toBe("source_review");
    expect(matter(await fs.readFile(added.sessionPath ?? "", "utf8")).data.origin).toBe("source_session");
    expect(
      detail.entries.some(
        (entry) =>
          entry.label === "guided-update" &&
          Boolean(entry.nextPath?.match(/^(sources|concepts|entities)\//)) &&
          !entry.nextPath?.startsWith("insights/")
      )
    ).toBe(true);

    const sourceSessionsDashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "source-sessions.md"), "utf8");
    expect(sourceSessionsDashboard).toContain("Pending Guided Bundles");
    expect(sourceSessionsDashboard).toContain(added.sessionId);
    const sourceGuidesDashboard = await fs.readFile(path.join(rootDir, "wiki", "dashboards", "source-guides.md"), "utf8");
    expect(sourceGuidesDashboard).toContain("Pending Guided Bundles");
    expect(sourceGuidesDashboard).toContain(added.approvalId ?? "");

    await acceptApproval(rootDir, added.approvalId ?? "");
    await compileVault(rootDir);
    const sessionState = JSON.parse(await fs.readFile(added.sessionStatePath, "utf8")) as { status: string };
    expect(sessionState.status).toBe("accepted");
    const sourcePage = await fs.readFile(path.join(rootDir, "wiki", "sources", `${awaiting.source.sourceIds[0]}.md`), "utf8");
    expect(sourcePage).toContain("## Guided Session Notes");
    expect(sourcePage).toContain("Guided Session Update");

    const guidedAgain = await guideManagedSource(rootDir, awaiting.source.sourceIds[0]!);
    expect(guidedAgain.awaitingInput).toBe(true);
    await fs.access(guidedAgain.sessionPath ?? "");
  });

  it("ingests workspace-local directories even when a parent repo gitignores the workspace", async () => {
    const parentDir = await createTempWorkspace();
    const rootDir = path.join(parentDir, "workspace");
    const researchDir = path.join(rootDir, "personal-research");

    await fs.mkdir(path.join(parentDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(parentDir, ".gitignore"), "workspace/\n", "utf8");
    await initVault(rootDir);
    await fs.mkdir(researchDir, { recursive: true });
    await fs.writeFile(
      path.join(researchDir, "call.srt"),
      ["1", "00:00:01,000 --> 00:00:02,000", "This transcript should not be skipped.", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, researchDir);

    expect(result.imported.some((manifest) => manifest.sourceKind === "transcript")).toBe(true);
    expect(result.skipped.some((entry) => entry.reason === "gitignore")).toBe(false);
  });
});
