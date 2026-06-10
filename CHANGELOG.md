# Changelog

## 0.1.17

- Made OCR-enhanced PDF creation enabled by default.
- Added a default-on option to create the OCR-enhanced PDF after the Markdown note is created.
- Added a visible OCR text layer mode setting with fast **Searchable text only** as the default.
- Updated OCR planning so PDFs with an existing text layer never request positioned Gemini coordinates.
- Reduced default Gemini payload for searchable OCR PDFs by using cleaned transcription/page text instead of requesting extra OCR page data.

## 0.1.16

- Added default-on customizable summary guidance for tone, focus, action-item context, major themes, and highlights.
- Added configurable action-item tagging with `#Todo` as the default tag.
- Strengthened transcription formatting instructions for sentence periods, readable Markdown structure, bold/italic emphasis, and duplicate-heading avoidance.
- Updated generated note details to show the `YYYY-MM-DD - Note Title` format and link the source PDF at both the beginning and end when not embedded.

## 0.1.15

- Improved plugin launch reliability by deferring output-folder creation until Obsidian layout readiness.
- Deferred `pdf-lib` loading until the optional OCR-enhanced PDF path actually needs it.
- Kept startup failures from output-folder setup from preventing the plugin from loading.

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
