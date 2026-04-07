import { z } from "zod";
import type { ChartSpec, OutputAsset, OutputFormat, SceneSpec } from "./types.js";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const chartSpecSchema = z.object({
  kind: z.enum(["bar", "line"]).default("bar"),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
  seriesLabel: z.string().optional(),
  data: z
    .array(
      z.object({
        label: z.string().min(1),
        value: z.number().finite()
      })
    )
    .min(2)
    .max(12),
  notes: z.array(z.string().min(1)).max(5).optional()
});

export const sceneSpecSchema = z.object({
  title: z.string().min(1),
  alt: z.string().min(1),
  background: z.string().optional(),
  width: z.number().int().positive().max(2400).optional(),
  height: z.number().int().positive().max(2400).optional(),
  elements: z
    .array(
      z.object({
        kind: z.enum(["shape", "label"]),
        shape: z.enum(["rect", "circle", "line"]).optional(),
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().optional(),
        height: z.number().finite().optional(),
        radius: z.number().finite().optional(),
        text: z.string().optional(),
        fontSize: z.number().finite().optional(),
        fill: z.string().optional(),
        stroke: z.string().optional(),
        strokeWidth: z.number().finite().optional(),
        opacity: z.number().finite().optional()
      })
    )
    .min(1)
    .max(32)
});

export function renderChartSvg(spec: ChartSpec): { svg: string; width: number; height: number } {
  const width = 1200;
  const height = 720;
  const margin = { top: 110, right: 80, bottom: 110, left: 110 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const values = spec.data.map((item) => item.value);
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(...values, 0);
  const domainMin = Math.min(0, minValue);
  const domainMax = maxValue <= domainMin ? domainMin + 1 : maxValue;
  const ticks = 5;
  const tickValues = Array.from({ length: ticks + 1 }, (_, index) => domainMin + ((domainMax - domainMin) * index) / ticks);
  const projectY = (value: number) => margin.top + chartHeight - ((value - domainMin) / (domainMax - domainMin || 1)) * chartHeight;
  const zeroY = projectY(0);
  const step = chartWidth / Math.max(1, spec.data.length);
  const barWidth = Math.min(84, step * 0.6);
  const points = spec.data.map((item, index) => {
    const centerX = margin.left + step * index + step / 2;
    const y = projectY(item.value);
    return { ...item, centerX, y };
  });

  const gridLines = tickValues
    .map((value) => {
      const y = projectY(value);
      return [
        `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#dbe4ec" stroke-width="1" />`,
        `<text x="${margin.left - 16}" y="${y + 4}" text-anchor="end" font-size="14" fill="#475569">${escapeXml(value.toFixed(0))}</text>`
      ].join("");
    })
    .join("");

  const bars =
    spec.kind === "bar"
      ? points
          .map((point) => {
            const top = Math.min(point.y, zeroY);
            const barHeight = Math.max(8, Math.abs(zeroY - point.y));
            return [
              `<rect x="${point.centerX - barWidth / 2}" y="${top}" width="${barWidth}" height="${barHeight}" rx="12" fill="#0ea5e9" opacity="0.92" />`,
              `<text x="${point.centerX}" y="${top - 10}" text-anchor="middle" font-size="13" fill="#0f172a">${escapeXml(
                point.value.toFixed(0)
              )}</text>`
            ].join("");
          })
          .join("")
      : "";

  const linePath =
    spec.kind === "line" ? points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.centerX} ${point.y}`).join(" ") : "";

  const lineMarks =
    spec.kind === "line"
      ? [
          `<path d="${linePath}" fill="none" stroke="#0ea5e9" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />`,
          ...points.map(
            (point) =>
              `<circle cx="${point.centerX}" cy="${point.y}" r="8" fill="#f8fafc" stroke="#0ea5e9" stroke-width="4" />
               <text x="${point.centerX}" y="${point.y - 18}" text-anchor="middle" font-size="13" fill="#0f172a">${escapeXml(
                 point.value.toFixed(0)
               )}</text>`
          )
        ].join("")
      : "";

  const labels = points
    .map(
      (point) =>
        `<text x="${point.centerX}" y="${height - margin.bottom + 28}" text-anchor="middle" font-size="14" fill="#334155">${escapeXml(
          point.label
        )}</text>`
    )
    .join("");

  const notes = (spec.notes ?? [])
    .map(
      (note, index) => `<text x="${margin.left}" y="${height - 26 - index * 18}" font-size="13" fill="#475569">${escapeXml(note)}</text>`
    )
    .join("");

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(spec.title)}">`,
    '<rect width="100%" height="100%" fill="#f8fafc" />',
    `<text x="${margin.left}" y="56" font-size="34" font-weight="700" fill="#0f172a">${escapeXml(spec.title)}</text>`,
    spec.subtitle ? `<text x="${margin.left}" y="86" font-size="18" fill="#475569">${escapeXml(spec.subtitle)}</text>` : "",
    gridLines,
    `<line x1="${margin.left}" y1="${zeroY}" x2="${width - margin.right}" y2="${zeroY}" stroke="#0f172a" stroke-width="2" />`,
    `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#0f172a" stroke-width="2" />`,
    bars,
    lineMarks,
    labels,
    spec.xLabel
      ? `<text x="${margin.left + chartWidth / 2}" y="${height - 46}" text-anchor="middle" font-size="15" fill="#475569">${escapeXml(spec.xLabel)}</text>`
      : "",
    spec.yLabel
      ? `<text x="34" y="${margin.top + chartHeight / 2}" text-anchor="middle" font-size="15" fill="#475569" transform="rotate(-90 34 ${
          margin.top + chartHeight / 2
        })">${escapeXml(spec.yLabel)}</text>`
      : "",
    spec.seriesLabel
      ? `<text x="${width - margin.right}" y="56" text-anchor="end" font-size="15" fill="#475569">${escapeXml(spec.seriesLabel)}</text>`
      : "",
    notes,
    "</svg>"
  ]
    .filter(Boolean)
    .join("");

  return { svg, width, height };
}

export function renderSceneSvg(spec: SceneSpec): { svg: string; width: number; height: number } {
  const width = clampNumber(spec.width ?? 1200, 480, 1600);
  const height = clampNumber(spec.height ?? 720, 320, 1200);
  const elements = spec.elements
    .map((element) => {
      const opacity = element.opacity === undefined ? 1 : clampNumber(element.opacity, 0, 1);
      if (element.kind === "label") {
        return `<text x="${element.x}" y="${element.y}" font-size="${clampNumber(element.fontSize ?? 28, 10, 72)}" fill="${escapeXml(
          element.fill ?? "#0f172a"
        )}" opacity="${opacity}" font-family="'Avenir Next', 'Segoe UI', sans-serif">${escapeXml(element.text ?? "")}</text>`;
      }

      switch (element.shape) {
        case "circle":
          return `<circle cx="${element.x}" cy="${element.y}" r="${Math.max(6, element.radius ?? 40)}" fill="${escapeXml(
            element.fill ?? "#dbeafe"
          )}" stroke="${escapeXml(element.stroke ?? "#0ea5e9")}" stroke-width="${Math.max(1, element.strokeWidth ?? 2)}" opacity="${opacity}" />`;
        case "line":
          return `<line x1="${element.x}" y1="${element.y}" x2="${element.x + (element.width ?? 120)}" y2="${
            element.y + (element.height ?? 0)
          }" stroke="${escapeXml(element.stroke ?? "#475569")}" stroke-width="${Math.max(1, element.strokeWidth ?? 3)}" opacity="${opacity}" />`;
        default:
          return `<rect x="${element.x}" y="${element.y}" width="${Math.max(8, element.width ?? 160)}" height="${Math.max(
            8,
            element.height ?? 120
          )}" rx="22" fill="${escapeXml(element.fill ?? "#e2e8f0")}" stroke="${escapeXml(element.stroke ?? "#94a3b8")}" stroke-width="${Math.max(
            1,
            element.strokeWidth ?? 2
          )}" opacity="${opacity}" />`;
      }
    })
    .join("");

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(
      spec.alt
    )}">`,
    `<rect width="100%" height="100%" fill="${escapeXml(spec.background ?? "#f8fafc")}" />`,
    `<text x="48" y="64" font-size="34" font-weight="700" fill="#0f172a">${escapeXml(spec.title)}</text>`,
    elements,
    `</svg>`
  ].join("");

  return { svg, width, height };
}

export function renderRasterPosterSvg(input: { title: string; alt: string; rasterFileName: string; width?: number; height?: number }): {
  svg: string;
  width: number;
  height: number;
} {
  const width = clampNumber(input.width ?? 1200, 480, 1600);
  const height = clampNumber(input.height ?? 720, 320, 1200);
  const inset = 42;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(
      input.alt
    )}">`,
    '<rect width="100%" height="100%" fill="#f8fafc" />',
    `<text x="${inset}" y="56" font-size="34" font-weight="700" fill="#0f172a">${escapeXml(input.title)}</text>`,
    `<image href="${escapeXml(input.rasterFileName)}" x="${inset}" y="92" width="${width - inset * 2}" height="${height - 148}" preserveAspectRatio="xMidYMid meet" />`,
    `</svg>`
  ].join("");

  return { svg, width, height };
}

export function buildOutputAssetManifest(input: {
  slug: string;
  format: OutputFormat;
  question: string;
  title: string;
  citations: string[];
  answer: string;
  assets: OutputAsset[];
  spec: ChartSpec | SceneSpec | Record<string, unknown>;
}): string {
  return `${JSON.stringify(
    {
      slug: input.slug,
      format: input.format,
      question: input.question,
      title: input.title,
      answer: input.answer,
      citations: input.citations,
      assets: input.assets,
      spec: input.spec
    },
    null,
    2
  )}\n`;
}
