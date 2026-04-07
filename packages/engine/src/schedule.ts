import fs from "node:fs/promises";
import path from "node:path";
import { loadVaultConfig } from "./config.js";
import { recordSession } from "./logs.js";
import type { ScheduleController, ScheduledRunResult, ScheduleStateRecord, ScheduleTriggerConfig } from "./types.js";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonFile } from "./utils.js";
import { compileVault, exploreVault, lintVault, queryVault } from "./vault.js";

function scheduleStatePath(schedulesDir: string, jobId: string): string {
  return path.join(schedulesDir, `${encodeURIComponent(jobId)}.json`);
}

function scheduleLockPath(schedulesDir: string, jobId: string): string {
  return path.join(schedulesDir, `${encodeURIComponent(jobId)}.lock`);
}

function parseEveryDuration(value: string): number {
  const match = value.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid schedule interval: ${value}`);
  }
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] ?? "m").toLowerCase();
  if (unit === "m") {
    return amount * 60_000;
  }
  if (unit === "h") {
    return amount * 60 * 60_000;
  }
  return amount * 24 * 60 * 60_000;
}

function parseCronField(field: string, min: number, max: number): number[] | null {
  if (field === "*") {
    return null;
  }

  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [base, stepRaw] = part.split("/");
      const step = Number.parseInt(stepRaw ?? "0", 10);
      if (!step || step < 1) {
        throw new Error(`Invalid cron step: ${field}`);
      }
      const [rangeStart, rangeEnd] =
        base === "*" || !base
          ? [min, max]
          : base.includes("-")
            ? base.split("-").map((item) => Number.parseInt(item, 10))
            : [Number.parseInt(base, 10), max];
      for (let value = rangeStart ?? min; value <= (rangeEnd ?? max); value += step) {
        if (value >= min && value <= max) {
          values.add(value);
        }
      }
      continue;
    }

    if (part.includes("-")) {
      const [start, end] = part.split("-").map((item) => Number.parseInt(item, 10));
      for (let value = start ?? min; value <= (end ?? max); value += 1) {
        if (value >= min && value <= max) {
          values.add(value);
        }
      }
      continue;
    }

    const value = Number.parseInt(part, 10);
    if (Number.isFinite(value) && value >= min && value <= max) {
      values.add(value);
    }
  }

  return values.size ? [...values].sort((left, right) => left - right) : [];
}

function matchesCron(value: Date, cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: ${cron}`);
  }
  const [minute, hour, day, month, weekday] = fields;
  const constraints = [
    [parseCronField(minute ?? "*", 0, 59), value.getUTCMinutes()],
    [parseCronField(hour ?? "*", 0, 23), value.getUTCHours()],
    [parseCronField(day ?? "*", 1, 31), value.getUTCDate()],
    [parseCronField(month ?? "*", 1, 12), value.getUTCMonth() + 1],
    [parseCronField(weekday ?? "*", 0, 6), value.getUTCDay()]
  ] as const;

  return constraints.every(([allowed, current]) => allowed === null || allowed.includes(current));
}

function nextCronRun(cron: string, from: Date): Date {
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let index = 0; index < 60 * 24 * 366; index += 1) {
    if (matchesCron(cursor, cron)) {
      return cursor;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`Could not resolve next cron run for ${cron}`);
}

function nextRunAt(trigger: ScheduleTriggerConfig, from: Date, lastRunAt?: string): string {
  if (trigger.every) {
    const interval = parseEveryDuration(trigger.every);
    const base = lastRunAt ? new Date(lastRunAt) : from;
    return new Date(base.getTime() + interval).toISOString();
  }
  if (trigger.cron) {
    return nextCronRun(trigger.cron, from).toISOString();
  }
  return from.toISOString();
}

async function readScheduleState(rootDir: string, jobId: string): Promise<ScheduleStateRecord | null> {
  const { paths } = await loadVaultConfig(rootDir);
  return readJsonFile<ScheduleStateRecord>(scheduleStatePath(paths.schedulesDir, jobId));
}

async function writeScheduleState(rootDir: string, state: ScheduleStateRecord): Promise<void> {
  const { paths } = await loadVaultConfig(rootDir);
  await writeJsonFile(scheduleStatePath(paths.schedulesDir, state.jobId), state);
}

async function acquireJobLease(rootDir: string, jobId: string): Promise<() => Promise<void>> {
  const { paths } = await loadVaultConfig(rootDir);
  const leasePath = scheduleLockPath(paths.schedulesDir, jobId);
  await ensureDir(paths.schedulesDir);
  const handle = await fs.open(leasePath, "wx");
  await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
  await handle.close();
  return async () => {
    await fs.rm(leasePath, { force: true });
  };
}

export async function listSchedules(rootDir: string): Promise<ScheduleStateRecord[]> {
  const { config } = await loadVaultConfig(rootDir);
  const now = new Date();
  const jobs = Object.entries(config.schedules ?? {}).sort((left, right) => left[0].localeCompare(right[0]));
  const states = await Promise.all(
    jobs.map(async ([jobId, job]) => {
      const existing = await readScheduleState(rootDir, jobId);
      return {
        jobId,
        enabled: job.enabled !== false,
        taskType: job.task.type,
        nextRunAt: job.enabled === false ? undefined : (existing?.nextRunAt ?? nextRunAt(job.when, now, existing?.lastRunAt)),
        lastRunAt: existing?.lastRunAt,
        lastStatus: existing?.lastStatus,
        lastSessionId: existing?.lastSessionId,
        lastApprovalId: existing?.lastApprovalId,
        error: existing?.error
      } satisfies ScheduleStateRecord;
    })
  );
  return states;
}

export async function runSchedule(rootDir: string, jobId: string): Promise<ScheduledRunResult> {
  const startedAt = new Date().toISOString();
  const { config, paths } = await loadVaultConfig(rootDir);
  const job = config.schedules?.[jobId];
  if (!job) {
    throw new Error(`Schedule not found: ${jobId}`);
  }
  if (job.enabled === false) {
    throw new Error(`Schedule is disabled: ${jobId}`);
  }

  const releaseLease = await acquireJobLease(rootDir, jobId);
  let success = true;
  let error: string | undefined;
  let approvalId: string | undefined;
  try {
    if (job.task.type === "compile") {
      const result = await compileVault(rootDir, { approve: job.task.approve ?? true });
      approvalId = result.approvalId;
    } else if (job.task.type === "lint") {
      await lintVault(rootDir, { deep: job.task.deep ?? false, web: job.task.web ?? false });
    } else if (job.task.type === "query") {
      const result = await queryVault(rootDir, {
        question: job.task.question,
        save: job.task.save ?? true,
        format: job.task.format,
        review: (job.task.save ?? true) === true
      });
      approvalId = result.approvalId;
    } else if (job.task.type === "explore") {
      const result = await exploreVault(rootDir, {
        question: job.task.question,
        steps: job.task.steps,
        format: job.task.format,
        review: true
      });
      approvalId = result.approvalId;
    }
  } catch (caught) {
    success = false;
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await releaseLease();
  }

  const finishedAt = new Date().toISOString();
  const session = await recordSession(rootDir, {
    operation: "schedule",
    title: `Schedule ${jobId}`,
    startedAt,
    finishedAt,
    success,
    error,
    lines: [`job=${jobId}`, `task=${job.task.type}`, `approval=${approvalId ?? "none"}`]
  });
  const state: ScheduleStateRecord = {
    jobId,
    enabled: true,
    taskType: job.task.type,
    nextRunAt: nextRunAt(job.when, new Date(finishedAt), finishedAt),
    lastRunAt: finishedAt,
    lastStatus: success ? "success" : "failed",
    lastSessionId: session.sessionId,
    lastApprovalId: approvalId,
    error
  };
  await writeScheduleState(rootDir, state);
  await appendJsonLine(paths.jobsLogPath, {
    kind: "schedule",
    jobId,
    taskType: job.task.type,
    startedAt,
    finishedAt,
    success,
    approvalId,
    error
  });

  return {
    jobId,
    taskType: job.task.type,
    startedAt,
    finishedAt,
    success,
    approvalId,
    error
  };
}

export async function serveSchedules(rootDir: string, pollMs = 30_000): Promise<ScheduleController> {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const tick = async () => {
    if (closed || running) {
      return;
    }
    running = true;
    try {
      const schedules = await listSchedules(rootDir);
      const due = schedules
        .filter((item) => item.enabled)
        .filter((item) => !item.nextRunAt || Date.parse(item.nextRunAt) <= Date.now())
        .sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""));
      for (const schedule of due) {
        if (closed) {
          break;
        }
        await runSchedule(rootDir, schedule.jobId);
      }
    } finally {
      running = false;
      if (!closed) {
        timer = setTimeout(() => void tick(), pollMs);
      }
    }
  };

  timer = setTimeout(() => void tick(), 10);

  return {
    close: async () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
}
