const {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl
} = require("obsidian");

const { PDFDocument, StandardFonts, rgb } = getPdfLib();

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-3.1-flash-lite",
  outputFolder: "Handwriting PDF Notes",
  includeSummary: true,
  summaryWordLimit: 200,
  createOcrPdf: false,
  autoDetectTextLayer: true,
  alwaysRequestPositionedOcr: false,
  ocrTextLayerMode: "searchable",
  overwriteExisting: false,
  includeFrontmatter: true
};

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function getPdfLib() {
  if (typeof PDFLib !== "undefined") return PDFLib;
  if (typeof module !== "undefined" && module.exports?.PDFDocument) return module.exports;
  return require("./pdf-lib.min.js");
}

module.exports = class HandwritingPdfPlugin extends Plugin {
  async onload() {
    const savedSettings = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    if (savedSettings?.createOcrPdf !== true && savedSettings?.ocrTextLayerMode === "positioned") {
      this.settings.ocrTextLayerMode = "searchable";
    }

    if (!savedSettings || savedSettings?.ocrTextLayerMode !== this.settings.ocrTextLayerMode) {
      await this.saveSettings();
    }

    await this.ensureOutputFolder();

    this.addSettingTab(new HandwritingPdfSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!isPdfFile(file)) return;
        menu.addItem((item) => {
          item
            .setTitle("Create handwriting note")
            .setIcon("file-text")
            .onClick(() => this.createNoteFromPdf(file));
        });
      })
    );

    this.addCommand({
      id: "create-handwriting-note-from-active-pdf",
      name: "Create handwriting note from active PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isPdfFile(file)) return false;
        if (!checking) this.createNoteFromPdf(file);
        return true;
      }
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async ensureOutputFolder() {
    const folder = normalizeOutputFolder(this.settings.outputFolder);
    if (folder) await ensureFolder(this.app, folder);
  }

  async createNoteFromPdf(pdfFile) {
    if (!this.settings.apiKey.trim()) {
      new Notice("Add a Gemini API key in Handwriting PDF settings first.");
      return;
    }

    const notice = new Notice("Handwriting PDF: reading PDF...", 0);

    try {
      const pdfData = await this.app.vault.readBinary(pdfFile);
      const base64Pdf = arrayBufferToBase64(pdfData);
      const hasTextOverlay = hasExistingPdfTextLayer(pdfData);

      notice.setMessage("Handwriting PDF: asking Gemini to read handwriting...");
      const result = await this.extractHandwriting(base64Pdf, pdfFile, hasTextOverlay);

      let embeddedPdfFile = pdfFile;
      if (this.settings.createOcrPdf) {
        notice.setMessage("Handwriting PDF: creating OCR text layer...");
        embeddedPdfFile = await this.writeOcrPdf(pdfFile, pdfData, result, result.ocrDetail);
      }

      notice.setMessage("Handwriting PDF: creating Markdown note...");
      const notePath = await this.writeMarkdownNote(pdfFile, embeddedPdfFile, result);

      notice.hide();
      new Notice(`Handwriting PDF: created ${notePath}`);

      const noteFile = this.app.vault.getAbstractFileByPath(notePath);
      if (noteFile instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(noteFile);
      }
    } catch (error) {
      notice.hide();
      console.error(error);
      new Notice(`Handwriting PDF failed: ${getErrorMessage(error)}`);
    }
  }

  async extractHandwriting(base64Pdf, pdfFile, hasTextOverlay) {
    const ocrDetail = getOcrDetailLevel(this.settings, hasTextOverlay);
    const prompt = buildExtractionPrompt(pdfFile.basename, this.settings.includeSummary, this.settings.summaryWordLimit, ocrDetail);
    const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(this.settings.model)}:generateContent?key=${encodeURIComponent(this.settings.apiKey.trim())}`;

    const response = await requestGeminiWithRetry({
      url,
      body: {
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: base64Pdf
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          thinkingConfig: {
            thinkingBudget: 0
          },
          responseMimeType: "application/json",
          responseSchema: buildResponseSchema(ocrDetail)
        }
      }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Gemini returned HTTP ${response.status}`);
    }

    const result = parseGeminiResponse(response.json);
    result.ocrDetail = ocrDetail;
    result.hasSourceTextOverlay = hasTextOverlay;
    return result;
  }

  async writeOcrPdf(sourcePdfFile, sourcePdfData, result, ocrDetail) {
    const date = normalizeDate(result.date) || window.moment().format("YYYY-MM-DD");
    const title = sanitizeTitle(result.title || sourcePdfFile.basename);
    const sourceTitle = sanitizeTitle(sourcePdfFile.basename);
    const folder = normalizeOutputFolder(this.settings.outputFolder);
    const outputName = `${date} - ${title} - ${sourceTitle} OCR.pdf`;
    const outputPath = await this.getAvailablePathForExtension(folder ? `${folder}/${outputName}` : outputName, "pdf");
    const ocrPdfBytes = await createOcrOverlayPdf(sourcePdfData, result, ocrDetail);

    if (folder) await ensureFolder(this.app, folder);
    const existing = this.app.vault.getAbstractFileByPath(outputPath);
    if (existing instanceof TFile && this.app.vault.modifyBinary) {
      await this.app.vault.modifyBinary(existing, uint8ArrayToArrayBuffer(ocrPdfBytes));
    } else if (!existing && this.app.vault.createBinary) {
      await this.app.vault.createBinary(outputPath, uint8ArrayToArrayBuffer(ocrPdfBytes));
    } else if (existing) {
      throw new Error(`OCR PDF already exists and cannot be modified: ${outputPath}`);
    } else {
      throw new Error("This Obsidian version does not support binary PDF creation.");
    }

    const created = this.app.vault.getAbstractFileByPath(outputPath);
    return created instanceof TFile ? created : new TFile(outputPath);
  }

  async writeMarkdownNote(pdfFile, embeddedPdfFile, result) {
    const date = normalizeDate(result.date) || window.moment().format("YYYY-MM-DD");
    const title = sanitizeTitle(result.title || pdfFile.basename);
    const outputName = `${date} - ${title}.md`;
    const folder = normalizeOutputFolder(this.settings.outputFolder);
    const notePath = await this.getAvailablePath(folder ? `${folder}/${outputName}` : outputName);
    const markdown = buildMarkdownNote({
      pdfFile,
      noteTitle: `${date} - ${title}`,
      result,
      model: this.settings.model,
      embeddedPdfFile,
      includeSummary: this.settings.includeSummary,
      includeFrontmatter: this.settings.includeFrontmatter
    });

    if (folder) await ensureFolder(this.app, folder);
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, markdown);
    } else {
      await this.app.vault.create(notePath, markdown);
    }
    return notePath;
  }

  async getAvailablePath(path) {
    return this.getAvailablePathForExtension(path, "md");
  }

  async getAvailablePathForExtension(path, extension) {
    const normalized = normalizePath(path);
    if (this.settings.overwriteExisting) return normalized;
    if (!this.app.vault.getAbstractFileByPath(normalized)) return normalized;

    const withoutExt = normalized.replace(new RegExp(`\\.${extension}$`, "i"), "");
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(`${withoutExt} ${index}.${extension}`)) {
      index += 1;
    }
    return `${withoutExt} ${index}.${extension}`;
  }
};

class HandwritingPdfSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("handwriting-pdf-settings");

    containerEl.createEl("h2", { text: "Handwriting PDF" });

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("Stored locally in this vault's plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc("Use a Gemini model that accepts PDF input and returns text.")
      .addText((text) =>
        text
          .setPlaceholder("gemini-3.1-flash-lite")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Generated notes are created here. Leave blank to create notes at the vault root.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.outputFolder)
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.ensureOutputFolder();
          })
      );

    new Setting(containerEl)
      .setName("Add summary")
      .setDesc("Add a concise summary before the transcription.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeSummary)
          .onChange(async (value) => {
            this.plugin.settings.includeSummary = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Summary word limit")
      .setDesc("Default is 200 words.")
      .addText((text) =>
        text
          .setPlaceholder("200")
          .setValue(String(this.plugin.settings.summaryWordLimit))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.summaryWordLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.summaryWordLimit;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Create OCR-enhanced PDF")
      .setDesc("When enabled, creates a copy of the PDF with an invisible Gemini text layer and embeds that copy in the generated note.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.createOcrPdf)
          .onChange(async (value) => {
            this.plugin.settings.createOcrPdf = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-detect existing PDF text layer")
      .setDesc("When enabled, image-only PDFs request positioned line data, while PDFs that already have a text layer use faster page text. When disabled, OCR-enhanced PDFs use faster page text unless positioned layout is forced.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoDetectTextLayer)
          .onChange(async (value) => {
            this.plugin.settings.autoDetectTextLayer = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Always request positioned OCR layout")
      .setDesc("Disabled by default. When enabled, Gemini returns page text and line coordinates for every PDF, even when an existing text layer is detected.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.alwaysRequestPositionedOcr)
          .onChange(async (value) => {
            this.plugin.settings.alwaysRequestPositionedOcr = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include frontmatter")
      .setDesc("Add source PDF and model metadata to generated notes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeFrontmatter)
          .onChange(async (value) => {
            this.plugin.settings.includeFrontmatter = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Overwrite existing note names")
      .setDesc("When disabled, duplicate names receive a numeric suffix.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.overwriteExisting)
          .onChange(async (value) => {
            this.plugin.settings.overwriteExisting = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

async function requestGeminiWithRetry({ url, body }) {
  const retryStatuses = new Set([429, 500, 502, 503, 504]);
  let lastResponse = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await requestUrl({
      url,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body)
    });

    lastResponse = response;
    if (!retryStatuses.has(response.status)) return response;
    if (attempt < 2) await sleep(1000 * Math.pow(2, attempt));
  }

  return lastResponse;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOcrDetailLevel(settings, hasTextOverlay) {
  if (!settings.createOcrPdf) return "none";
  if (settings.alwaysRequestPositionedOcr) return "positioned";
  if (settings.autoDetectTextLayer && hasTextOverlay) return "searchable";
  if (settings.autoDetectTextLayer && !hasTextOverlay) return "positioned";
  return "searchable";
}

function hasExistingPdfTextLayer(pdfData) {
  const content = bytesToLatin1(pdfData);
  const textOperators = countMatches(content, /\bTj\b|\bTJ\b/g);
  const fontRefs = countMatches(content, /\/Font\b/g);
  const unicodeMaps = countMatches(content, /\/ToUnicode\b/g);

  if (unicodeMaps > 0 && textOperators > 0) return true;
  return fontRefs > 0 && textOperators >= 20;
}

function buildResponseSchema(ocrDetail) {
  const schema = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      date: { type: "STRING" },
      summary: { type: "STRING" },
      markdown: { type: "STRING" }
    },
    required: ["title", "date", "summary", "markdown"]
  };

  if (ocrDetail === "searchable") {
    schema.properties.pages = {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          pageNumber: { type: "NUMBER" },
          text: { type: "STRING" }
        },
        required: ["pageNumber", "text"]
      }
    };
  }

  if (ocrDetail === "positioned") {
    schema.properties.pages = {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          pageNumber: { type: "NUMBER" },
          text: { type: "STRING" },
          lines: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                text: { type: "STRING" },
                x: { type: "NUMBER" },
                y: { type: "NUMBER" },
                width: { type: "NUMBER" },
                height: { type: "NUMBER" }
              },
              required: ["text", "x", "y", "width", "height"]
            }
          }
        },
        required: ["pageNumber", "text", "lines"]
      }
    };
  }

  return schema;
}

function buildExtractionPrompt(sourceName, includeSummary, summaryWordLimit, ocrDetail) {
  const lines = [
    "You are transcribing a handwritten note PDF for an Obsidian vault.",
    "Read the handwriting from the visible PDF pages. The visual page content is the source of truth.",
    "If an invisible OCR text layer is present, treat it only as a weak hint for ambiguous characters. Do not let hidden OCR text shorten, summarize, reorder, or replace the visible handwriting transcription.",
    "Make a complete page-by-page pass from the first page through the last page. Include all legible headings, bullets, labels, marginal notes, and short fragments. Do not compress repeated list items or skip low-confidence but legible content.",
    "Return strict JSON only. Do not wrap the JSON in Markdown.",
    "",
    "JSON fields:",
    "- title: concise note title without date.",
    "- date: best inferred primary note date in YYYY-MM-DD. If multiple dates appear, use the first date and include the range in markdown if useful. If no date appears, use an empty string.",
    `- summary: ${includeSummary ? `a concise summary no longer than ${summaryWordLimit} words` : "an empty string"}.`,
    "- markdown: the full transcription as Obsidian-friendly Markdown.",
  ];

  if (ocrDetail === "searchable") {
    lines.push(
      "- pages: compact page-by-page OCR data for creating a searchable invisible PDF text layer.",
      "",
      "For each pages item:",
      "- pageNumber: 1-based page number.",
      "- text: all transcribed text for that page in reading order.",
      "- Do not include line coordinates in searchable mode.",
      ""
    );
  }

  if (ocrDetail === "positioned") {
    lines.push(
      "- pages: page-by-page OCR data for creating an invisible PDF text layer.",
      "",
      "For each pages item:",
      "- pageNumber: 1-based page number.",
      "- text: all transcribed text for that page in reading order.",
      "- lines: line-level OCR objects in reading order.",
      "- Each line must include text plus x, y, width, and height as normalized decimals from 0 to 1.",
      "- Use top-left page coordinates: x is distance from left edge, y is distance from top edge, width and height are the line box dimensions.",
      "- Estimate coordinates from the visible handwriting layout as accurately as possible. Keep coordinates close to the handwritten line, not the hidden OCR layer.",
      "- Keep line text compact; do not duplicate paragraphs in both line text and extra fields.",
      ""
    );
  }

  lines.push(
    "Markdown requirements:",
    "- Preserve inferred headings, bullets, numbering, indentation, emphasis, and tables.",
    "- Preserve the original reading order. When a page boundary is meaningful, add a subtle `### Page N` heading.",
    "- Correct obvious spelling, grammar, capitalization, and punctuation errors so the transcription is readable and understandable.",
    "- Preserve the original meaning. Do not rewrite ideas, summarize the transcription, or add content that is not present in the note.",
    "- Convert mathematical notation and formulas to LaTeX using $...$ or $$...$$.",
    "- Keep uncertain words in [unclear] brackets instead of inventing content.",
    "- Do not include a duplicate title heading, summary heading, source PDF embed, or YAML frontmatter in markdown.",
    "",
    `Source filename hint: ${sourceName}`
  );

  return lines.join("\n");
}

function parseGeminiResponse(json) {
  const text = json?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) throw new Error("Gemini returned no text");

  try {
    const parsed = JSON.parse(repairCommonJsonIssues(stripJsonFence(text)));
    return {
      title: String(parsed.title || "").trim(),
      date: String(parsed.date || "").trim(),
      summary: String(parsed.summary || "").trim(),
      markdown: String(parsed.markdown || "").trim(),
      pages: normalizeOcrPages(parsed.pages)
    };
  } catch (error) {
    return {
      title: "",
      date: "",
      summary: "",
      markdown: stripJsonFence(text),
      pages: []
    };
  }
}

function buildMarkdownNote({ pdfFile, embeddedPdfFile, noteTitle, result, model, includeSummary, includeFrontmatter }) {
  const sections = [];
  const sourceLink = `[[${pdfFile.path}]]`;
  const embeddedLink = `[[${embeddedPdfFile.path}]]`;
  const embedLink = `![[${embeddedPdfFile.path}]]`;

  if (includeFrontmatter) {
    sections.push([
      "---",
      `source_pdf: "${escapeYaml(sourceLink)}"`,
      `embedded_pdf: "${escapeYaml(embeddedLink)}"`,
      `ocr_model: "${escapeYaml(model)}"`,
      `created: "${window.moment().format("YYYY-MM-DDTHH:mm:ssZ")}"`,
      "---"
    ].join("\n"));
  }

  sections.push(`# ${noteTitle}`);

  if (includeSummary && result.summary) {
    sections.push(["## Summary", result.summary].join("\n\n"));
  }

  sections.push(["## Transcription", result.markdown || "_No transcription returned._"].join("\n\n"));
  sections.push(["## Source PDF", embedLink].join("\n\n"));

  return `${sections.join("\n\n")}\n`;
}

async function createOcrOverlayPdf(sourcePdfData, result, mode) {
  const pdfDoc = await PDFDocument.load(sourcePdfData);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const ocrPages = normalizeOcrPages(result.pages);
  const pageTextFallback = buildPageTextFallback(result.markdown);

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    const ocrPage = ocrPages.find((candidate) => candidate.pageNumber === pageIndex + 1);
    const lines = mode === "positioned" ? getPositionedLines(ocrPage) : [];

    if (lines.length) {
      drawPositionedInvisibleText(page, font, lines, width, height);
    } else {
      const text = ocrPage?.text || pageTextFallback[pageIndex] || result.markdown || "";
      drawSearchableInvisibleText(page, font, text, width, height);
    }
  }

  return pdfDoc.save({ useObjectStreams: false });
}

function drawPositionedInvisibleText(page, font, lines, pageWidth, pageHeight) {
  for (const line of lines) {
    const text = sanitizePdfText(line.text);
    if (!text) continue;

    const boxWidth = clamp(line.width, 0.02, 1) * pageWidth;
    const boxHeight = clamp(line.height, 0.01, 0.2) * pageHeight;
    const x = clamp(line.x, 0, 0.98) * pageWidth;
    const y = pageHeight - (clamp(line.y, 0, 0.98) * pageHeight) - boxHeight;
    const size = fitFontSize(font, text, boxWidth, clamp(boxHeight * 0.78, 4, 18));

    page.drawText(text, {
      x,
      y: clamp(y, 0, pageHeight - size),
      size,
      font,
      color: rgb(0, 0, 0),
      opacity: 0
    });
  }
}

function drawSearchableInvisibleText(page, font, text, pageWidth, pageHeight) {
  const lines = wrapTextForPdf(sanitizePdfText(text), 110);
  const size = 6;
  const lineHeight = size * 1.25;
  let y = pageHeight - 12;

  for (const line of lines) {
    if (y < 8) break;
    page.drawText(line, {
      x: 8,
      y,
      size,
      font,
      maxWidth: pageWidth - 16,
      color: rgb(0, 0, 0),
      opacity: 0
    });
    y -= lineHeight;
  }
}

function normalizeOcrPages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((page, index) => ({
      pageNumber: normalizePageNumber(page?.pageNumber, index + 1),
      text: String(page?.text || "").trim(),
      lines: normalizeOcrLines(page?.lines)
    }))
    .filter((page) => page.pageNumber > 0 && (page.text || page.lines.length));
}

function normalizeOcrLines(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((line) => ({
      text: String(line?.text || "").trim(),
      x: normalizeUnit(line?.x),
      y: normalizeUnit(line?.y),
      width: normalizeUnit(line?.width),
      height: normalizeUnit(line?.height)
    }))
    .filter((line) => line.text && line.width > 0 && line.height > 0);
}

function normalizePageNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function normalizeUnit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return clamp(parsed, 0, 1);
}

function getPositionedLines(page) {
  if (!page || !Array.isArray(page.lines)) return [];
  return page.lines.filter((line) => line.text && line.width > 0 && line.height > 0);
}

function buildPageTextFallback(markdown) {
  const pages = [];
  const blocks = String(markdown || "").split(/^### Page\s+\d+\s*$/gim).map((block) => block.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  pages.push(stripMarkdownForPdfText(markdown));
  return pages;
}

function stripMarkdownForPdfText(markdown) {
  return String(markdown || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function sanitizePdfText(value) {
  return String(value || "")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[•·]/g, "-")
    .replace(/[→↪↳⇒]/g, "->")
    .replace(/[←⇐]/g, "<-")
    .replace(/[≤]/g, "<=")
    .replace(/[≥]/g, ">=")
    .replace(/[×]/g, "x")
    .replace(/[÷]/g, "/")
    .replace(/\r/g, "\n")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapTextForPdf(text, maxChars) {
  const output = [];
  for (const paragraph of String(text || "").split(/\n+/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxChars && line) {
        output.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) output.push(line);
  }
  return output;
}

function fitFontSize(font, text, maxWidth, preferredSize) {
  let size = preferredSize;
  while (size > 3 && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

async function ensureFolder(app, folderPath) {
  const parts = normalizePath(folderPath).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function isPdfFile(file) {
  return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}

function normalizeOutputFolder(folder) {
  return normalizePath(folder || "").replace(/^\/+|\/+$/g, "");
}

function normalizeDate(value) {
  const match = String(value || "").match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return match ? match[0] : "";
}

function sanitizeTitle(value) {
  const sanitized = String(value || "Untitled Note")
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "Untitled Note";
}

function stripJsonFence(value) {
  return String(value || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function repairCommonJsonIssues(value) {
  return String(value || "")
    .replace(/\{\s*"([^"]+)"\s*,\s*"x"\s*:/g, '{ "text": "$1", "x":');
}

function escapeYaml(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return window.btoa(binary);
}

function bytesToLatin1(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return binary;
}

function countMatches(value, pattern) {
  return (String(value || "").match(pattern) || []).length;
}

function uint8ArrayToArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
