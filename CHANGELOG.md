# Changelog

## 0.1.14

- Reinforced the AI-mediated cleanup path so generated Markdown remains readable, structured, and polished.
- Clarified that grammar, punctuation, headings, bullets, and emphasis cleanup must stay faithful to the handwritten note.
- Kept the local formatting preflight focused on limiting extra table/list/math effort, not disabling normal transcription cleanup.

## 0.1.13

- Added a cheap local PDF structure preflight for table, list, math, and ink hints.
- Updated the Gemini prompt so tables, lists, and math receive extra formatting effort only when local hints or clearly visible page layout justify it.
- Kept the workflow single-pass with no extra Gemini calls or expanded response schema.

## 0.1.12

- Improved handwritten table handling by prompting Gemini to use GitHub-flavored Markdown tables when table structure is clear.
- Added a lightweight Markdown table cleanup pass so simple pipe tables render reliably in Obsidian.
- Added table validity metrics to the local conversion audit script.
- Added this changelog to the repository.

## 0.1.11

- Added timing logs for the main conversion workflow.
- Added a curated Gemini model dropdown while keeping `gemini-3.1-flash-lite` as the default.
- Added model-aware thinking configuration for Gemini 3 and Gemini 2.5 models.

## 0.1.10

- Rewrote the README to be clearer and more casual.
- Made generated notes start with the title at the top.
- Linked PDFs by default, with an optional setting to embed them.

## 0.1.9

- Refactored plugin internals to improve Repowise health.
- Reduced repeated settings and OCR PDF logic.

## 0.1.8

- Prepared the project for Obsidian community plugin release checks.
- Added GitHub Actions for validation and release asset publishing.
- Added bundled `pdf-lib` release packaging.
