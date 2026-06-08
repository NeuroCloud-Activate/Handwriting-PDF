# Handwriting PDF

Turn handwritten PDF notes into clean Obsidian notes without doing the copy-paste dance.

Handwriting PDF is a small Obsidian plugin for those PDFs that are full of useful handwritten notes but are annoying to search, skim, or reuse. Pick a PDF, run the plugin, and it asks Gemini to read the handwriting, clean up the obvious typos and punctuation, preserve the structure it can understand, and drop everything into a fresh Markdown note.

Current version: `0.1.16`.

This project was built in collaboration with AI using OpenAI Codex.

## What It Does

By default, Handwriting PDF keeps the workflow simple:

- Right-click a PDF on desktop, or use the file action on mobile.
- Send the selected PDF to Gemini for handwriting recognition.
- Create a new note named `YYYY-MM-DD - NoteTitle.md`.
- Put the note title at the very top of the file.
- Add a short summary before the transcription.
- Turn the handwriting into readable Markdown with headings, bullets, emphasis, tables, and LaTeX-style math when Gemini can identify them.
- Keep the AI cleanup path on by default so obvious spelling, grammar, capitalization, punctuation, headings, and bold emphasis are cleaned up or preserved when supported by the visible note.
- Let you customize the summary guidance while keeping summaries short, useful, and focused on context, action items, themes, and highlights.
- Tag clear meeting action items with `#Todo` by default, using a configurable tag.
- Format clear handwritten table layouts as Markdown tables that render in Obsidian.
- Use a cheap local formatting preflight so tables, lists, and math only get extra formatting attention when the PDF hints or visible layout call for it.
- Keep the transcription faithful: cleanup should not change the note's content, meaning, numbers, dates, or conclusions.
- Link back to the PDF inside your vault instead of embedding it by default.
- Save generated notes in `Handwriting PDF Notes` unless you choose a different folder.
- Log timing details to the developer console so slow steps are easier to spot.

The goal is simple: handwritten PDF in, useful Obsidian note out.

## Setup

Install the plugin in your vault, open the Handwriting PDF settings, and add your Gemini API key. The default model is `gemini-3.1-flash-lite`. You can also choose another PDF-friendly handwriting model from the dropdown.

That is the main setup. After that, select a PDF and run **Create handwriting note**.

## Generated Note Layout

Generated notes are meant to be easy to scan:

```markdown
# 2026-06-07 - Example Title

## Details
- Source PDF: [[example.pdf]]
- OCR model: `gemini-3.1-flash-lite`
- Note title format: YYYY-MM-DD - Note Title

## Summary

...

## Transcription

...

## Source PDF

[[example.pdf]]
```

If you turn on **Embed PDF in note**, the final PDF section uses an embed instead:

```markdown
![[example.pdf]]
```

## Optional OCR PDF Copy

There is also an optional OCR-enhanced PDF feature. It is off by default.

When enabled, the plugin creates a separate PDF copy with an invisible searchable text layer and links or embeds that copy in the generated note. The original PDF is not changed.

To keep things fast, the plugin checks whether the PDF already has a text layer:

- If a text layer already exists, Gemini only needs to return compact page text.
- If the PDF is image-only, Gemini can return line positions so the plugin can build a better searchable layer.
- You can force positioned OCR for every PDF, but that is slower and uses more API output.

## Privacy and Network Use

This plugin needs your own Gemini API key. When you run a conversion, the selected PDF is sent to Google's Gemini API for handwriting recognition, cleanup, formatting, and optional summary generation.

The API key is saved in Obsidian's local plugin data for the current vault. The plugin does not include a bundled API key, does not run ads, and does not collect telemetry.

## Notes

Handwriting recognition is only as good as the source PDF and the model response. The plugin tries to preserve structure, but messy handwriting, cramped margins, and complex layouts can still need a quick human pass.

This plugin bundles `pdf-lib` under the MIT license; see `PDF-LIB-LICENSE.md`.
