# Handwriting PDF

Handwriting PDF is an Obsidian plugin that turns handwritten PDF notes into formatted Markdown using Gemini document understanding.

Current version: `0.1.9`.

## Features

- Adds a PDF file-menu action for desktop right-click and mobile file actions.
- Adds a command for the active PDF file.
- Sends the PDF directly to Gemini as `application/pdf`.
- Creates a note named `YYYY-MM-DD - NoteTitle.md`.
- Creates a default `Handwriting PDF Notes` output folder when the plugin loads.
- Preserves headings, lists, emphasis, tables, and equations as Markdown/LaTeX when Gemini can infer them.
- Corrects obvious spelling, grammar, capitalization, and punctuation while preserving the note's meaning.
- Optionally adds a concise summary before the transcription.
- Embeds the source PDF, or an OCR-enhanced PDF copy when that optional setting is enabled, at the end of the generated note.
- Can optionally create a local OCR-enhanced PDF copy with an invisible Gemini text layer. This uses bundled JavaScript PDF processing and does not require native command-line tools.

## Setup

Install the plugin in an Obsidian vault, then open the plugin settings and add a Gemini API key. The default model is `gemini-3.1-flash-lite`; change it in settings if Google exposes a newer compatible model. Generated notes are created in `Handwriting PDF Notes` by default, and that folder can be changed in settings.

The OCR-enhanced PDF option is disabled by default. When enabled, the plugin creates a separate `OCR.pdf` copy in the output folder and embeds that copy in the Markdown note. The original PDF is not modified.

## Privacy and Network Use

This plugin requires a user-provided Gemini API key. When you run conversion, the selected PDF is sent to Google's Gemini API for handwriting recognition, text cleanup, formatting, and optional summary generation. The API key is saved in Obsidian's local plugin data for the current vault. The plugin does not include a bundled API key, does not run ads, and does not collect telemetry.

For speed, the plugin only asks Gemini for the data required by the source PDF and selected output:

- Standard Markdown conversion does not request PDF overlay layout data.
- OCR-enhanced PDF creation first checks whether the source PDF already has a text layer.
- PDFs with an existing text layer request compact page-level text only and preserve the PDF's existing text positioning.
- PDFs without an existing text layer request Gemini line-level coordinates so the new invisible text layer can be positioned.
- A separate advanced setting can force positioned OCR layout for every PDF. It is disabled by default because it is slower and uses more API output.
- If auto-detect is disabled and forced positioned layout is also disabled, OCR-enhanced PDF creation uses faster searchable page text for every PDF.
- Gemini generation is configured with low temperature and disabled thinking budget where supported to reduce latency for this extraction task.

## Output Format

Generated notes use this structure:

```markdown
---
source_pdf: "[[example.pdf]]"
embedded_pdf: "[[2026-06-07 - Example Title OCR.pdf]]"
ocr_model: gemini-3.1-flash-lite
---

# 2026-06-07 - Example Title

## Summary

...

## Transcription

...

## Source PDF

![[2026-06-07 - Example Title OCR.pdf]]
```

## Limitations

The OCR-enhanced PDF feature writes an invisible searchable text layer on device. Auto-detect is enabled by default: PDFs that already contain an OCR text layer avoid the slower line-coordinate request, while image-only PDFs require Gemini-estimated line boxes and fall back to a searchable page text layer when coordinates are missing. Exact alignment depends on the quality of Gemini's returned layout data.

This plugin bundles `pdf-lib` under the MIT license; see `PDF-LIB-LICENSE.md`.

## Community Plugin Release

This repository is structured for Obsidian community plugin submission:

- Root files include `README.md`, `LICENSE`, `manifest.json`, `versions.json`, `main.js`, and `styles.css`.
- `manifest.json`, `package.json`, and `versions.json` all declare version `0.1.9`.
- The plugin id is `handwriting-pdf`, which uses lowercase letters and hyphens and does not include `obsidian` or end with `plugin`.
- `isDesktopOnly` is `false`; the plugin avoids Node.js and Electron runtime APIs so it can run on desktop and mobile Obsidian.
- GitHub release tags must match the `manifest.json` version exactly.
- Release uploads are built into `dist/` and should include `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`.
- The release `main.js` is self-contained and bundles `pdf-lib`; no separate dependency file is required in the GitHub release assets.

Run these checks before creating a release:

```bash
npm run check
```
