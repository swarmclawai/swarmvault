# PDF Extraction Strategy

SwarmVault's PDF extraction is a **best-effort** pipeline. PDFs are a lossy medium — layout, tables, and embedded images do not always survive extraction — and the 1.0 default extractor is a deliberate choice that prioritizes fidelity of plain prose over reproduction of complex layout. This document records that choice so users know what to expect.

## Default extractor

`pdf-parse` (Mozilla `pdf.js` under the hood) runs at ingest time on every `.pdf` source. Output is plain UTF-8 text with paragraph breaks preserved at the text-layer boundaries the PDF reports. Result is written to `state/extracts/<source-id>.md` alongside a JSON sidecar with page count and first/last page offsets.

We picked this default because:

- It works on every platform SwarmVault runs on (macOS, Linux, Windows) without native binaries.
- It does not require a provider API key — the heuristic `swarmvault init` path produces usable PDF extractions with no network.
- It is deterministic — the same PDF always produces the same extraction, which keeps `source_hashes` stable.

## Known limitations

- **Tables** render as interleaved text. Columns that the PDF presents visually get flattened into reading-order text. The compile-time AST walker in `analysis.ts` then looks for rationale markers and headings on the flattened prose; table structure is not preserved in the graph.
- **Scanned PDFs with no text layer** produce empty extractions. There is no OCR in the 1.0 default path. For scanned documents, ingest the original image files separately (`.png` / `.jpg`) — the vision provider path will see them.
- **Multi-column layouts** that rely on column breaks for reading order sometimes interleave sentences incorrectly. The paragraph-grouping fallback in `extractRationaleFromMarkdown` tolerates this but rationale markers inside fragmented paragraphs may not be detected.
- **Mathematical notation** is preserved only to the extent the source PDF embedded the glyphs as text. LaTeX-rendered math typically arrives as garbled Unicode.
- **Embedded images** are not extracted. Ingest the figures separately if they matter.

## Opting into richer extraction

Two extension points exist today and neither is on by default in 1.0:

### Vision-based PDF understanding (experimental)

Configure a vision provider and set `tasks.visionProvider` to a capability that includes `vision`. At ingest, a future extension path will render PDF pages as images and send them through vision. **This path is not wired into the 1.0 default** — it is an experimental opt-in that remains on the post-1.0 roadmap. Users who need it today can run an external renderer and drop the images into `inbox/`.

### Custom PDF extractor module

Set `providers.<id>.type = "custom"` and point `module` at a Node ESM file that exports a PDF-aware extractor matching the internal extractor signature. This escape hatch is covered by the **Experimental** tier in `STABILITY.md`.

## Recommendations by use case

- **Academic papers with prose body**: the default is fine; you will get clean text with paragraph breaks. Figures and tables will be missing but captions usually survive.
- **Financial reports and spreadsheet-derived PDFs**: consider converting to `.xlsx` or `.csv` at the source. SwarmVault's structured extractors handle those natively.
- **Scanned archives / image-heavy PDFs**: run an external OCR pass and ingest the resulting `.txt` or `.md` files.
- **Slide decks**: convert to `.pptx` where possible. The PPTX extractor produces one entry per slide, which aligns better with the compile graph than a flattened PDF.

## Why PDF is not a first-class source in 1.0

The `spec.md` "Risks And Open Questions" section flagged PDF extraction variance as an unresolved 1.0 concern. Picking a single default, documenting the trade-offs, and marking richer strategies as experimental is the 1.0 resolution. Post-1.0 work on vision-based PDF understanding and bundled OCR is scheduled once the single default has stabilized across real-world vaults.
