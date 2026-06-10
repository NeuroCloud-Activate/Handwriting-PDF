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

const COMPATIBLE_MODELS = [
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash-Lite",
    description: "Fastest default for PDF handwriting notes."
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Higher quality for harder handwriting, slower."
  },
  {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    description: "Advanced multimodal reasoning, slowest option."
  }
];

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-3.1-flash-lite",
  outputFolder: "Handwriting PDF Notes",
  noteTitleFormat: "YYYY-MM-DD - NoteTitle",
  includeSummary: true,
  summaryWordLimit: 200,
  summaryPromptEnabled: true,
  summaryPrompt: "Write a short, useful summary that stays faithful to the note. Focus on major themes, key highlights, useful context, and any clear action items without adding new interpretation.",
  actionItemTagging: true,
  actionItemTag: "#Todo",
  createOcrPdf: true,
  createOcrPdfAfterNote: true,
  autoDetectTextLayer: true,
  alwaysRequestPositionedOcr: false,
  ocrTextLayerMode: "searchable",
  overwriteExisting: false,
  includeFrontmatter: true,
  embedPdf: false
};

const SUMMARY_TOGGLE_SETTINGS = [
  {
    key: "includeSummary",
    name: "Add summary",
    description: "Add a concise summary before the transcription."
  },
  {
    key: "summaryPromptEnabled",
    name: "Use custom summary guidance",
    description: "Use your summary prompt to focus tone, context, themes, highlights, and action items."
  }
];

const ACTION_ITEM_TOGGLE_SETTINGS = [
  {
    key: "actionItemTagging",
    name: "Tag action items",
    description: "When clear meeting action items are present, append the configured tag to those items."
  }
];

const OCR_TOGGLE_SETTINGS = [
  {
    key: "createOcrPdf",
    name: "Create OCR-enhanced PDF",
    description: "Enabled by default. Creates a PDF copy with an invisible searchable text layer."
  },
  {
    key: "createOcrPdfAfterNote",
    name: "Create OCR PDF after note creation",
    description: "Enabled by default. Creates the Markdown note first, then adds the OCR-enhanced PDF in the background."
  },
  {
    key: "autoDetectTextLayer",
    name: "Auto-detect existing PDF text layer",
    description: "Keeps PDFs with an existing text layer on the faster searchable path and avoids requesting positioned coordinates."
  },
  {
    key: "alwaysRequestPositionedOcr",
    name: "Prefer positioned OCR for image-only PDFs",
    description: "Disabled by default. When enabled, image-only PDFs request line coordinates. PDFs with an existing text layer still use the faster searchable path."
  }
];

const OCR_TEXT_LAYER_MODE_OPTIONS = [
  {
    id: "searchable",
    name: "Searchable text only",
    description: "Fastest. Uses cleaned transcription/page text without asking Gemini for line coordinates."
  },
  {
    id: "positioned",
    name: "Positioned line layer",
    description: "Slower. Requests line coordinates only for PDFs without an existing text layer."
  }
];

const NOTE_TOGGLE_SETTINGS = [
  {
    key: "includeFrontmatter",
    name: "Include note details",
    description: "Add source PDF and model details below the note title."
  },
  {
    key: "embedPdf",
    name: "Embed PDF in note",
    description: "Disabled by default. When off, the note links to the PDF instead of embedding it."
  },
  {
    key: "overwriteExisting",
    name: "Overwrite existing note names",
    description: "When disabled, duplicate names receive a numeric suffix."
  }
];

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
let cachedPdfLib = null;

function getPdfLib() {
  if (cachedPdfLib) return cachedPdfLib;
  if (typeof globalThis !== "undefined" && globalThis.PDFLib) {
    cachedPdfLib = globalThis.PDFLib;
    return cachedPdfLib;
  }

  cachedPdfLib = require("./pdf-lib.min.js");
  return cachedPdfLib;
}

class HandwritingPdfPlugin extends Plugin {
  async onload() {
    const savedSettings = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    this.settings.ocrTextLayerMode = normalizeOcrTextLayerMode(this.settings.ocrTextLayerMode);

    if (!savedSettings || savedSettings?.ocrTextLayerMode !== this.settings.ocrTextLayerMode || savedSettings?.createOcrPdfAfterNote === undefined) {
      await this.saveSettings();
    }

    this.deferOutputFolderSetup();

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

  deferOutputFolderSetup() {
    const createFolder = () => {
      this.ensureOutputFolder().catch((error) => {
        console.warn("Handwriting PDF could not create the output folder during startup.", error);
      });
    };

    if (typeof this.app.workspace.onLayoutReady === "function") {
      this.app.workspace.onLayoutReady(createFolder);
    } else {
      createFolder();
    }
  }

  async createNoteFromPdf(pdfFile) {
    if (!this.settings.apiKey.trim()) {
      new Notice("Add a Gemini API key in Handwriting PDF settings first.");
      return;
    }

    const timings = createTimingTracker();
    const notice = new Notice("Handwriting PDF: reading PDF...", 0);

    try {
      const conversion = await this.preparePdfConversion(pdfFile, timings, notice);
      const output = await this.writeInitialOutputs(conversion, timings, notice);
      await this.finishSuccessfulConversion(conversion, output, timings, notice);
    } catch (error) {
      notice.hide();
      console.error(error);
      new Notice(`Handwriting PDF failed: ${getErrorMessage(error)}`);
    }
  }

  async preparePdfConversion(pdfFile, timings, notice) {
    const pdfData = await this.app.vault.readBinary(pdfFile);
    timings.mark("readPdf");

    const base64Pdf = arrayBufferToBase64(pdfData);
    timings.mark("encodePdf");

    const pdfSignals = analyzePdfSignals(pdfData);
    const hasTextOverlay = pdfSignals.hasTextOverlay;
    const ocrPlan = getOcrPlan(this.settings, hasTextOverlay);
    timings.mark("analyzePdfStructure");

    notice.setMessage("Handwriting PDF: asking Gemini to read handwriting...");
    const result = await this.extractHandwriting({ base64Pdf, pdfFile, hasTextOverlay, structureHints: pdfSignals.structureHints, ocrPlan });
    timings.mark("geminiRequest");

    return { pdfFile, pdfData, pdfSignals, hasTextOverlay, ocrPlan, result };
  }

  async writeInitialOutputs(conversion, timings, notice) {
    const createOcrAfterNote = conversion.ocrPlan.shouldCreate && this.settings.createOcrPdfAfterNote;
    const embeddedPdfFile = await this.getInitialEmbeddedPdfFile(conversion, createOcrAfterNote, timings, notice);

    notice.setMessage("Handwriting PDF: creating Markdown note...");
    const notePath = await this.writeMarkdownNote(conversion.pdfFile, embeddedPdfFile, conversion.result, {
      ocrPending: createOcrAfterNote
    });
    timings.mark("writeMarkdown");

    return { notePath, createOcrAfterNote };
  }

  async getInitialEmbeddedPdfFile(conversion, createOcrAfterNote, timings, notice) {
    if (!conversion.ocrPlan.shouldCreate || createOcrAfterNote) return conversion.pdfFile;

    notice.setMessage("Handwriting PDF: creating OCR text layer...");
    const embeddedPdfFile = await this.writeOcrPdf(conversion.pdfFile, conversion.pdfData, conversion.result, conversion.ocrPlan.overlayMode);
    timings.mark("writeOcrPdf");
    return embeddedPdfFile;
  }

  async finishSuccessfulConversion(conversion, output, timings, notice) {
    notice.hide();
    new Notice(output.createOcrAfterNote ? `Handwriting PDF: created ${output.notePath}; OCR PDF queued.` : `Handwriting PDF: created ${output.notePath}`);
    this.startQueuedOcrPdf(conversion, output);
    logTimingSummary({
      timings,
      model: this.settings.model,
      ocrDetail: conversion.ocrPlan.requestDetail,
      ocrOverlayMode: conversion.ocrPlan.overlayMode,
      hasTextOverlay: conversion.hasTextOverlay,
      structureHints: conversion.pdfSignals.structureHints,
      createOcrPdf: this.settings.createOcrPdf
    });

    await this.openGeneratedNote(output.notePath);
  }

  startQueuedOcrPdf(conversion, output) {
    if (!output.createOcrAfterNote) return;

    this.createOcrPdfInBackground({
      pdfFile: conversion.pdfFile,
      pdfData: conversion.pdfData,
      result: conversion.result,
      notePath: output.notePath,
      ocrPlan: conversion.ocrPlan
    });
  }

  async openGeneratedNote(notePath) {
    const noteFile = this.app.vault.getAbstractFileByPath(notePath);
    if (noteFile instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(noteFile);
    }
  }

  async extractHandwriting({ base64Pdf, pdfFile, hasTextOverlay, structureHints, ocrPlan = getOcrPlan(this.settings, hasTextOverlay) }) {
    const ocrDetail = ocrPlan.requestDetail;
    const prompt = buildExtractionPrompt({
      sourceName: pdfFile.basename,
      includeSummary: this.settings.includeSummary,
      summaryWordLimit: this.settings.summaryWordLimit,
      summaryPromptEnabled: this.settings.summaryPromptEnabled,
      summaryPrompt: this.settings.summaryPrompt,
      actionItemTagging: this.settings.actionItemTagging,
      actionItemTag: this.settings.actionItemTag,
      ocrDetail,
      structureHints
    });
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
          thinkingConfig: buildThinkingConfig(this.settings.model),
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
    result.ocrOverlayMode = ocrPlan.overlayMode;
    result.hasSourceTextOverlay = hasTextOverlay;
    return result;
  }

  createOcrPdfInBackground({ pdfFile, pdfData, result, notePath, ocrPlan }) {
    const backgroundTimings = createTimingTracker();
    this.finishBackgroundOcrPdf({ pdfFile, pdfData, result, notePath, ocrPlan, backgroundTimings }).catch((error) => {
      console.error(error);
      new Notice(`Handwriting PDF: OCR PDF creation failed: ${getErrorMessage(error)}`);
    });
  }

  async finishBackgroundOcrPdf({ pdfFile, pdfData, result, notePath, ocrPlan, backgroundTimings }) {
    const embeddedPdfFile = await this.writeOcrPdf(pdfFile, pdfData, result, ocrPlan.overlayMode);
    backgroundTimings.mark("writeOcrPdfBackground");
    await this.updateMarkdownNotePdf(pdfFile, embeddedPdfFile, result, notePath);
    backgroundTimings.mark("updateMarkdownNote");
    new Notice("Handwriting PDF: OCR-enhanced PDF created.");
    console.info("Handwriting PDF background OCR timing", {
      totalMs: backgroundTimings.summary().totalMs,
      ocrOverlayMode: ocrPlan.overlayMode,
      stages: backgroundTimings.summary().stages
    });
  }

  async writeOcrPdf(sourcePdfFile, sourcePdfData, result, ocrDetail) {
    const { folder, outputPath } = await this.getOcrPdfTarget(sourcePdfFile, result);
    const ocrPdfBytes = await createOcrOverlayPdf(sourcePdfData, result, ocrDetail);

    if (folder) await ensureFolder(this.app, folder);
    await this.writeBinaryPdf(outputPath, ocrPdfBytes);

    const created = this.app.vault.getAbstractFileByPath(outputPath);
    return created instanceof TFile ? created : new TFile(outputPath);
  }

  async getOcrPdfTarget(sourcePdfFile, result) {
    const { noteTitle } = this.getGeneratedNoteNaming(sourcePdfFile, result);
    const sourceTitle = sanitizeTitle(sourcePdfFile.basename);
    const folder = normalizeOutputFolder(this.settings.outputFolder);
    const outputName = `${noteTitle} - ${sourceTitle} OCR.pdf`;
    const requestedPath = folder ? `${folder}/${outputName}` : outputName;

    return {
      folder,
      outputPath: await this.getAvailablePathForExtension(requestedPath, "pdf")
    };
  }

  async writeBinaryPdf(outputPath, bytes) {
    const content = uint8ArrayToArrayBuffer(bytes);
    const existing = this.app.vault.getAbstractFileByPath(outputPath);

    if (existing instanceof TFile && this.app.vault.modifyBinary) {
      await this.app.vault.modifyBinary(existing, content);
      return;
    }

    if (!existing && this.app.vault.createBinary) {
      await this.app.vault.createBinary(outputPath, content);
      return;
    }

    if (existing) {
      throw new Error(`OCR PDF already exists and cannot be modified: ${outputPath}`);
    }

    throw new Error("This Obsidian version does not support binary PDF creation.");
  }

  async writeMarkdownNote(pdfFile, embeddedPdfFile, result, options = {}) {
    const { noteTitle, outputName } = this.getGeneratedNoteNaming(pdfFile, result);
    const folder = normalizeOutputFolder(this.settings.outputFolder);
    const notePath = await this.getAvailablePath(folder ? `${folder}/${outputName}` : outputName);
    const markdown = buildMarkdownNote({
      pdfFile,
      noteTitle,
      result,
      model: this.settings.model,
      embeddedPdfFile,
      includeSummary: this.settings.includeSummary,
      includeFrontmatter: this.settings.includeFrontmatter,
      embedPdf: this.settings.embedPdf,
      ocrPending: options.ocrPending === true
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

  async updateMarkdownNotePdf(pdfFile, embeddedPdfFile, result, notePath) {
    const noteFile = this.app.vault.getAbstractFileByPath(notePath);
    if (!(noteFile instanceof TFile)) return;

    const { noteTitle } = this.getGeneratedNoteNaming(pdfFile, result);
    const markdown = buildMarkdownNote({
      pdfFile,
      noteTitle,
      result,
      model: this.settings.model,
      embeddedPdfFile,
      includeSummary: this.settings.includeSummary,
      includeFrontmatter: this.settings.includeFrontmatter,
      embedPdf: this.settings.embedPdf,
      ocrPending: false
    });

    await this.app.vault.modify(noteFile, markdown);
  }

  getGeneratedNoteNaming(pdfFile, result) {
    const date = normalizeDate(result.date) || window.moment().format("YYYY-MM-DD");
    const title = sanitizeTitle(result.title || pdfFile.basename);
    const noteTitle = formatNoteTitle(this.settings.noteTitleFormat, { date, title });
    return {
      noteTitle,
      outputName: `${noteTitle}.md`
    };
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
}

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
    this.renderGeminiSettings(containerEl);
    this.renderOutputSettings(containerEl);
    this.renderSummarySettings(containerEl);
    this.renderOcrSettings(containerEl);
    this.renderNoteSettings(containerEl);
  }

  renderGeminiSettings(containerEl) {
    addTextSetting(containerEl, {
      name: "Gemini API key",
      description: "Stored locally in this vault's plugin data.",
      placeholder: "API key",
      value: this.plugin.settings.apiKey,
      password: true,
      onChange: async (value) => {
        this.plugin.settings.apiKey = value.trim();
        await this.plugin.saveSettings();
      }
    });

    addDropdownSetting(containerEl, {
      name: "Gemini model",
      description: "Choose a Gemini model that supports PDF input and handwriting recognition.",
      options: getModelOptions(this.plugin.settings.model),
      value: this.plugin.settings.model,
      onChange: async (value) => {
        this.plugin.settings.model = value || DEFAULT_SETTINGS.model;
        await this.plugin.saveSettings();
      }
    });
  }

  renderOutputSettings(containerEl) {
    addTextSetting(containerEl, {
      name: "Output folder",
      description: "Generated notes are created here. Leave blank to create notes at the vault root.",
      placeholder: DEFAULT_SETTINGS.outputFolder,
      value: this.plugin.settings.outputFolder,
      onChange: async (value) => {
        this.plugin.settings.outputFolder = value.trim();
        await this.plugin.saveSettings();
        await this.plugin.ensureOutputFolder();
      }
    });

    addTextSetting(containerEl, {
      name: "Note title format",
      description: "Use YYYY-MM-DD for the note date and NoteTitle for the cleaned note title.",
      placeholder: DEFAULT_SETTINGS.noteTitleFormat,
      value: this.plugin.settings.noteTitleFormat,
      onChange: async (value) => {
        this.plugin.settings.noteTitleFormat = value.trim() || DEFAULT_SETTINGS.noteTitleFormat;
        await this.plugin.saveSettings();
      }
    });
  }

  renderSummarySettings(containerEl) {
    addBoundToggleSettings(containerEl, this.plugin, SUMMARY_TOGGLE_SETTINGS);

    addTextSetting(containerEl, {
      name: "Summary word limit",
      description: "Default is 200 words.",
      placeholder: "200",
      value: String(this.plugin.settings.summaryWordLimit),
      onChange: async (value) => {
        const parsed = Number.parseInt(value, 10);
        this.plugin.settings.summaryWordLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.summaryWordLimit;
        await this.plugin.saveSettings();
      }
    });

    addTextAreaSetting(containerEl, {
      name: "Summary guidance",
      description: "Used when custom summary guidance is enabled. Keep this focused on the summary style and content you want.",
      placeholder: DEFAULT_SETTINGS.summaryPrompt,
      value: this.plugin.settings.summaryPrompt,
      onChange: async (value) => {
        this.plugin.settings.summaryPrompt = value.trim() || DEFAULT_SETTINGS.summaryPrompt;
        await this.plugin.saveSettings();
      }
    });
  }

  renderOcrSettings(containerEl) {
    addBoundToggleSettings(containerEl, this.plugin, OCR_TOGGLE_SETTINGS);

    addDropdownSetting(containerEl, {
      name: "OCR text layer mode",
      description: "Choose how the optional OCR-enhanced PDF text layer is created.",
      options: OCR_TEXT_LAYER_MODE_OPTIONS,
      value: normalizeOcrTextLayerMode(this.plugin.settings.ocrTextLayerMode),
      onChange: async (value) => {
        this.plugin.settings.ocrTextLayerMode = normalizeOcrTextLayerMode(value);
        await this.plugin.saveSettings();
      }
    });
  }

  renderNoteSettings(containerEl) {
    addBoundToggleSettings(containerEl, this.plugin, NOTE_TOGGLE_SETTINGS);
    addBoundToggleSettings(containerEl, this.plugin, ACTION_ITEM_TOGGLE_SETTINGS);

    addTextSetting(containerEl, {
      name: "Action item tag",
      description: "Added to clear action items when action item tagging is enabled.",
      placeholder: DEFAULT_SETTINGS.actionItemTag,
      value: this.plugin.settings.actionItemTag,
      onChange: async (value) => {
        this.plugin.settings.actionItemTag = normalizeActionItemTag(value) || DEFAULT_SETTINGS.actionItemTag;
        await this.plugin.saveSettings();
      }
    });
  }
}

function addTextSetting(containerEl, { name, description, placeholder, value, password = false, onChange }) {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addText((text) => {
      if (password) text.inputEl.type = "password";
      text
        .setPlaceholder(placeholder)
        .setValue(value)
        .onChange(onChange);
    });
}

function addTextAreaSetting(containerEl, { name, description, placeholder, value, onChange }) {
  const setting = new Setting(containerEl)
    .setName(name)
    .setDesc(description);

  if (typeof setting.addTextArea === "function") {
    setting.addTextArea((text) => {
      text
        .setPlaceholder(placeholder)
        .setValue(value)
        .onChange(onChange);
      text.inputEl.rows = 4;
      text.inputEl.addClass("handwriting-pdf-textarea");
    });
    return;
  }

  setting.addText((text) => {
    text
      .setPlaceholder(placeholder)
      .setValue(value)
      .onChange(onChange);
  });
}

function addToggleSetting(containerEl, { name, description, value, onChange }) {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addToggle((toggle) => toggle.setValue(value).onChange(onChange));
}

function addDropdownSetting(containerEl, { name, description, options, value, onChange }) {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addDropdown((dropdown) => {
      for (const option of options) {
        dropdown.addOption(option.id, `${option.name} - ${option.description}`);
      }
      dropdown
        .setValue(value)
        .onChange(onChange);
    });
}

function addBoundToggleSettings(containerEl, plugin, settings) {
  for (const setting of settings) {
    addToggleSetting(containerEl, {
      name: setting.name,
      description: setting.description,
      value: plugin.settings[setting.key],
      onChange: async (value) => {
        plugin.settings[setting.key] = value;
        await plugin.saveSettings();
      }
    });
  }
}

function getModelOptions(currentModel) {
  if (!currentModel || COMPATIBLE_MODELS.some((model) => model.id === currentModel)) {
    return COMPATIBLE_MODELS;
  }

  return [
    {
      id: currentModel,
      name: `${currentModel} (saved)`,
      description: "Previously saved model ID."
    },
    ...COMPATIBLE_MODELS
  ];
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
  return getOcrPlan(settings, hasTextOverlay).requestDetail;
}

function getOcrPlan(settings, hasTextOverlay) {
  if (!settings.createOcrPdf) {
    return {
      shouldCreate: false,
      requestDetail: "none",
      overlayMode: "none"
    };
  }

  const overlayMode = getOcrOverlayMode(settings, hasTextOverlay);
  return {
    shouldCreate: true,
    requestDetail: overlayMode === "positioned" ? "positioned" : "none",
    overlayMode
  };
}

function getOcrOverlayMode(settings, hasTextOverlay) {
  if (hasTextOverlay) return "searchable";

  const mode = normalizeOcrTextLayerMode(settings.ocrTextLayerMode);
  if (mode === "positioned" || settings.alwaysRequestPositionedOcr === true) return "positioned";
  return "searchable";
}

function normalizeOcrTextLayerMode(value) {
  return value === "positioned" ? "positioned" : "searchable";
}

function buildThinkingConfig(model) {
  if (isGemini3Flash(model)) return { thinkingLevel: "minimal" };
  if (isGemini3Model(model)) return { thinkingLevel: "low" };
  if (isGemini25ThinkingModel(model)) return { thinkingBudget: 0 };
  return {};
}

function isGemini3Flash(model) {
  return /^gemini-3(?:[\w.-]*flash|.*flash)/i.test(String(model || ""));
}

function isGemini3Model(model) {
  return /^gemini-3/i.test(String(model || ""));
}

function isGemini25ThinkingModel(model) {
  return /^gemini-2\.5/i.test(String(model || ""));
}

function hasExistingPdfTextLayer(pdfData) {
  return analyzePdfSignals(pdfData).hasTextOverlay;
}

function analyzePdfSignals(pdfData) {
  const content = bytesToLatin1(pdfData);
  const textOperators = countMatches(content, /\bTj\b|\bTJ\b/g);
  const fontRefs = countMatches(content, /\/Font\b/g);
  const unicodeMaps = countMatches(content, /\/ToUnicode\b/g);
  const hasTextOverlay = (unicodeMaps > 0 && textOperators > 0) || (fontRefs > 0 && textOperators >= 20);

  return {
    hasTextOverlay,
    structureHints: {
      likelyTables: hasLikelyTableSignals(content),
      likelyLists: hasLikelyListSignals(content),
      likelyMath: hasLikelyMathSignals(content),
      likelyInk: hasLikelyInkSignals(content)
    }
  };
}

function hasLikelyTableSignals(content) {
  const pipeRows = countMatches(content, /\|[^|\r\n]+\|[^|\r\n]+\|/g);
  const tableWords = countMatches(content, /\b(table|column|row|grid|schedule|matrix)\b/gi);
  const vectorLineSignals = countMatches(content, /\/Subtype\s*\/Line\b|\/L\s*\[/g);
  return pipeRows >= 2 || tableWords >= 2 || vectorLineSignals >= 4;
}

function hasLikelyListSignals(content) {
  const bulletSignals = countMatches(content, /[•·]|(?:^|[\r\n])\s*[-*+]\s+/g);
  const numberedSignals = countMatches(content, /(?:^|[\r\n])\s*\d+[.)]\s+/g);
  return bulletSignals + numberedSignals >= 2;
}

function hasLikelyMathSignals(content) {
  return countMatches(content, /[=<>±×÷≤≥∑√∞µ]|\\(?:alpha|beta|sum|frac|sqrt)\b/g) >= 2;
}

function hasLikelyInkSignals(content) {
  return countMatches(content, /\/Subtype\s*\/Ink\b|\/InkList\b|\/Annots\b/g) > 0;
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

  const pageSchema = buildPageResponseSchema(ocrDetail);
  if (pageSchema) schema.properties.pages = pageSchema;

  return schema;
}

function buildPageResponseSchema(ocrDetail) {
  if (!["searchable", "positioned"].includes(ocrDetail)) return null;

  const properties = {
    pageNumber: { type: "NUMBER" },
    text: { type: "STRING" }
  };
  const required = ["pageNumber", "text"];

  if (ocrDetail === "positioned") {
    properties.lines = buildLineResponseSchema();
    required.push("lines");
  }

  return {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties,
      required
    }
  };
}

function buildLineResponseSchema() {
  return {
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
  };
}

function buildExtractionPrompt({
  sourceName,
  includeSummary,
  summaryWordLimit,
  summaryPromptEnabled = true,
  summaryPrompt = DEFAULT_SETTINGS.summaryPrompt,
  actionItemTagging = true,
  actionItemTag = DEFAULT_SETTINGS.actionItemTag,
  ocrDetail,
  structureHints = {}
}) {
  const normalizedActionItemTag = normalizeActionItemTag(actionItemTag) || DEFAULT_SETTINGS.actionItemTag;
  const lines = [
    "You are transcribing a handwritten note PDF for an Obsidian vault.",
    "Read the handwriting from the visible PDF pages. The visual page content is the source of truth.",
    "Primary goal: produce a faithful transcription that is immediately usable as a clear Markdown note.",
    "You may lightly clean spelling, grammar, capitalization, and punctuation, and apply Markdown structure such as headings, bold emphasis, bullets, numbering, and paragraph breaks when the visible note supports it.",
    "Do not change the note's content, conclusions, intent, clinical/scientific meaning, numbers, names, dates, measurements, or relationships between ideas.",
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

  lines.push(...buildSummaryGuidancePromptLines({
    includeSummary,
    summaryPromptEnabled,
    summaryPrompt,
    summaryWordLimit
  }));
  lines.push(...buildActionItemPromptLines({ actionItemTagging, actionItemTag: normalizedActionItemTag }));
  lines.push(...buildOcrDetailPromptLines(ocrDetail));
  lines.push(...buildStructureHintPromptLines(structureHints));

  lines.push(
    "Markdown requirements:",
    "- Always return readable, well-structured Markdown rather than a raw OCR dump.",
    "- Preserve clear headings, indentation, bullets, numbering, checkboxes, paragraph grouping, and emphasis when they are visible or strongly implied by the handwritten layout.",
    "- Use at least four leading spaces for nested sub-bullets or nested numbered list items.",
    "- Use Markdown headings, bold text, and italic text to reflect visible note hierarchy, labels, emphasized terms, definitions, and important phrases when doing so improves clarity.",
    "- Do not add duplicate title headings, duplicate section headings, or repeated labels that the final note wrapper already provides.",
    "- Preserve the original reading order. When a page boundary is meaningful, add a subtle `### Page N` heading.",
    "- Correct obvious spelling, grammar, capitalization, and punctuation errors only when the correction is clear from context and improves readability.",
    "- End every complete sentence with a period. Do not force periods onto headings, tags, URLs, table separators, abbreviations, or intentionally short labels/fragments.",
    "- Preserve the original meaning. Do not rewrite ideas, summarize the transcription, normalize specialized wording, or add content that is not present in the note.",
    "- Use the local formatting preflight rules above for extra table, list, and math handling so higher-effort structure work is only used when detected or clearly visible.",
    "- Keep uncertain words in [unclear] brackets instead of inventing content.",
    "- Do not include a duplicate title heading, summary heading, source PDF embed, or YAML frontmatter in markdown.",
    "",
    `Source filename hint: ${sourceName}`
  );

  return lines.join("\n");
}

function buildSummaryGuidancePromptLines({ includeSummary, summaryPromptEnabled, summaryPrompt, summaryWordLimit }) {
  if (!includeSummary) return [];

  const guidance = summaryPromptEnabled
    ? String(summaryPrompt || DEFAULT_SETTINGS.summaryPrompt).trim()
    : DEFAULT_SETTINGS.summaryPrompt;

  return [
    "",
    "Summary requirements:",
    `- Keep the summary under ${summaryWordLimit} words.`,
    "- Make it relevant, detailed, and short enough to scan quickly.",
    "- Include useful context for action items, major themes, and highlights when they are present in the note.",
    "- Keep the same tone and meaning as the handwritten note; do not add conclusions or advice not present in the note.",
    `- User summary guidance: ${guidance}`,
    ""
  ];
}

function buildActionItemPromptLines({ actionItemTagging, actionItemTag }) {
  if (!actionItemTagging) return [];

  return [
    "",
    "Action item tracking:",
    `- When the note contains clear meeting action items, tasks, next steps, or assigned follow-ups, preserve them as Markdown bullets and append ${actionItemTag} to each action item.`,
    `- Use ${actionItemTag} only for action items that are actually present or strongly implied by the handwritten note. Do not invent tasks.`,
    "- If a note has no clear action items, do not add action-item bullets just to use the tag.",
    ""
  ];
}

function buildStructureHintPromptLines(structureHints) {
  const hints = normalizeStructureHints(structureHints);
  const lines = [
    "Local formatting preflight:",
    `- likely handwritten or embedded ink: ${hints.likelyInk ? "yes" : "no"}.`,
    `- likely table/grid structure: ${hints.likelyTables ? "yes" : "no"}.`,
    `- likely bullet or numbered list structure: ${hints.likelyLists ? "yes" : "no"}.`,
    `- likely math/formula structure: ${hints.likelyMath ? "yes" : "no"}.`,
    "- These local hints are cheap and may miss handwritten structures. The visible PDF pages remain the source of truth.",
    ""
  ];

  if (hints.likelyTables) {
    lines.push(
      "- Table formatting: convert clear handwritten grid tables, comparison charts, lab values, schedules, and column-style note blocks into GitHub-flavored Markdown tables.",
      "- For tables, keep cells concise and faithful; do not invent missing cells, use [unclear] for uncertain content, leave truly blank cells empty, and include the Markdown separator row."
    );
  } else {
    lines.push("- Table formatting: do not spend extra effort creating Markdown tables unless the visible page layout clearly contains an aligned table or grid.");
  }

  if (hints.likelyLists) {
    lines.push("- List formatting: preserve visible bullets, numbering, checkboxes, and indentation as Markdown lists.");
  } else {
    lines.push("- List formatting: do not do extra list reconstruction beyond obvious visible bullets, numbering, checkboxes, or indentation.");
  }

  if (hints.likelyMath) {
    lines.push("- Math formatting: convert visible formulas and mathematical notation to LaTeX using $...$ or $$...$$.");
  } else {
    lines.push("- Math formatting: do not create LaTeX unless visible mathematical notation or formulas are present.");
  }

  lines.push("");
  return lines;
}

function normalizeStructureHints(value) {
  return {
    likelyTables: value?.likelyTables === true,
    likelyLists: value?.likelyLists === true,
    likelyMath: value?.likelyMath === true,
    likelyInk: value?.likelyInk === true
  };
}

function buildOcrDetailPromptLines(ocrDetail) {
  if (ocrDetail === "none") return [];

  const modeText = ocrDetail === "positioned"
    ? "page-by-page OCR data for creating an invisible PDF text layer"
    : "compact page-by-page OCR data for creating a searchable invisible PDF text layer";
  const lines = [
    `- pages: ${modeText}.`,
    "",
    "For each pages item:",
    "- pageNumber: 1-based page number.",
    "- text: all transcribed text for that page in reading order."
  ];

  if (ocrDetail === "searchable") {
    lines.push("- Do not include line coordinates in searchable mode.");
  }

  if (ocrDetail === "positioned") {
    lines.push(
      "- lines: line-level OCR objects in reading order.",
      "- Each line must include text plus x, y, width, and height as normalized decimals from 0 to 1.",
      "- Use top-left page coordinates: x is distance from left edge, y is distance from top edge, width and height are the line box dimensions.",
      "- Estimate coordinates from the visible handwriting layout as accurately as possible. Keep coordinates close to the handwritten line, not the hidden OCR layer.",
      "- Keep line text compact; do not duplicate paragraphs in both line text and extra fields."
    );
  }

  lines.push("");
  return lines;
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
      markdown: normalizeGeneratedMarkdown(String(parsed.markdown || "").trim()),
      pages: normalizeOcrPages(parsed.pages)
    };
  } catch (error) {
    return {
      title: "",
      date: "",
      summary: "",
      markdown: normalizeGeneratedMarkdown(stripJsonFence(text)),
      pages: []
    };
  }
}

function buildMarkdownNote({ pdfFile, embeddedPdfFile, noteTitle, result, model, includeSummary, includeFrontmatter, embedPdf, ocrPending = false }) {
  const sections = [];
  const sourceLink = `[[${pdfFile.path}]]`;
  const embeddedLink = `[[${embeddedPdfFile.path}]]`;
  const pdfReference = embedPdf ? `![[${embeddedPdfFile.path}]]` : sourceLink;
  const cleanedSummary = cleanGeneratedSummary(result.summary);
  const cleanedTranscription = cleanGeneratedTranscription(result.markdown, {
    noteTitle,
    title: result.title
  });

  sections.push(`# ${noteTitle}`);
  addDetailsSection(sections, {
    sourceLink,
    embeddedLink,
    hasOcrPdf: embeddedPdfFile.path !== pdfFile.path,
    model,
    includeFrontmatter,
    embedPdf,
    ocrPending
  });

  if (includeSummary && cleanedSummary) {
    sections.push(["## Summary", cleanedSummary].join("\n\n"));
  }

  sections.push(["## Transcription", cleanedTranscription || "_No transcription returned._"].join("\n\n"));
  sections.push(["## Source PDF", pdfReference].join("\n\n"));

  return `${sections.join("\n\n")}\n`;
}

function addDetailsSection(sections, { sourceLink, embeddedLink, hasOcrPdf, model, includeFrontmatter, embedPdf, ocrPending }) {
  if (includeFrontmatter) {
    sections.push(buildDetailsSection({ sourceLink, embeddedLink, hasOcrPdf, model, ocrPending }));
    return;
  }

  if (!embedPdf) sections.push(`Source PDF: ${sourceLink}`);
}

function buildDetailsSection({ sourceLink, embeddedLink, hasOcrPdf, model, ocrPending }) {
  return [
    "## Details",
    `- Source PDF: ${sourceLink}`,
    buildOcrPdfDetailLine({ embeddedLink, hasOcrPdf, ocrPending }),
    `- OCR model: \`${model}\``
  ].filter(Boolean).join("\n");
}

function buildOcrPdfDetailLine({ embeddedLink, hasOcrPdf, ocrPending }) {
  if (hasOcrPdf) return `- OCR-enhanced PDF: ${embeddedLink}`;
  if (ocrPending) return "- OCR-enhanced PDF: pending";
  return "";
}

function cleanGeneratedSummary(summary) {
  return stripLeadingWrapperLines(summary, {
    titles: [],
    sectionHeadings: ["summary"]
  });
}

function cleanGeneratedTranscription(markdown, { noteTitle, title }) {
  return stripLeadingWrapperLines(markdown, {
    titles: [noteTitle, title],
    sectionHeadings: ["details", "summary", "transcription", "source pdf", "source"]
  });
}

function stripLeadingWrapperLines(value, { titles, sectionHeadings }) {
  const lines = String(value || "").trim().split("\n");
  const titleSet = new Set(titles.map(normalizeHeadingText).filter(Boolean));
  const sectionSet = new Set(sectionHeadings.map(normalizeHeadingText));

  while (stripNextWrapperLine(lines, titleSet, sectionSet)) {}
  stripDuplicateTitleAfterLeadingPage(lines, titleSet);

  return lines.join("\n").trim();
}

function stripDuplicateTitleAfterLeadingPage(lines, titleSet) {
  const pageHeadingIndex = findNextContentLine(lines, 0);
  if (!isPageHeading(lines[pageHeadingIndex])) return;

  const titleIndex = findNextContentLine(lines, pageHeadingIndex + 1);
  if (titleIndex < 0 || !isDuplicateTitleLine(lines[titleIndex], titleSet)) return;

  lines.splice(titleIndex, 1);
}

function findNextContentLine(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (String(lines[index] || "").trim()) return index;
  }
  return -1;
}

function stripNextWrapperLine(lines, titleSet, sectionSet) {
  if (!lines.length) return false;

  const line = lines[0].trim();
  if (!line) {
    lines.shift();
    return true;
  }

  if (line === "---") {
    removeYamlFrontmatter(lines);
    return true;
  }

  if (isDuplicateWrapperLine(line, titleSet, sectionSet)) {
    lines.shift();
    return true;
  }

  return false;
}

function isDuplicateWrapperLine(line, titleSet, sectionSet) {
  const headingText = getMarkdownHeadingText(line);
  const normalizedHeading = normalizeHeadingText(headingText);
  if (normalizedHeading) {
    return titleSet.has(normalizedHeading) || sectionSet.has(normalizedHeading);
  }

  return titleSet.has(normalizeHeadingText(line));
}

function isDuplicateTitleLine(line, titleSet) {
  return isDuplicateWrapperLine(line, titleSet, new Set());
}

function isPageHeading(line) {
  return /^#{1,6}\s+Page\s+\d+\b/i.test(String(line || "").trim());
}

function removeYamlFrontmatter(lines) {
  lines.shift();
  while (lines.length && lines[0].trim() !== "---") {
    lines.shift();
  }
  if (lines[0]?.trim() === "---") lines.shift();
}

function getMarkdownHeadingText(line) {
  const match = String(line || "").match(/^#{1,6}\s+(.+?)\s*#*$/);
  return match ? match[1] : "";
}

function normalizeHeadingText(value) {
  return String(value || "")
    .replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, "")
    .replace(/[*_`[\]()#:.!?,;-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeGeneratedMarkdown(markdown) {
  return normalizeMarkdownTables(normalizeNestedListIndentation(markdown));
}

function normalizeNestedListIndentation(markdown) {
  return String(markdown || "")
    .split("\n")
    .map(normalizeNestedListLine)
    .join("\n")
    .trim();
}

function normalizeNestedListLine(line) {
  const match = String(line || "").match(/^(\s+)([-*+]|\d+[.)])\s+/);
  if (!match) return line;

  const indentWidth = countIndentWidth(match[1]);
  if (indentWidth >= 4 && !match[1].includes("\t")) return line;

  return `${" ".repeat(Math.max(4, indentWidth))}${line.trimStart()}`;
}

function countIndentWidth(indent) {
  return Array.from(String(indent || "")).reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);
}

function normalizeMarkdownTables(markdown) {
  const lines = String(markdown || "").split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    if (!isTableRow(lines[index])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const tableLines = [];
    while (index < lines.length && isTableRow(lines[index])) {
      tableLines.push(lines[index]);
      index += 1;
    }
    output.push(...normalizeTableBlock(tableLines));
  }

  return output.join("\n").trim();
}

function normalizeTableBlock(lines) {
  if (lines.length < 2) return lines;

  const rows = lines.map(parseTableRow);
  const columnCount = Math.max(...rows.map((row) => row.length));
  if (columnCount < 2) return lines;

  const normalized = rows.map((row) => formatTableRow(padTableRow(row, columnCount)));
  if (!isTableSeparatorRow(rows[1])) {
    normalized.splice(1, 0, formatTableSeparator(columnCount));
  }

  return normalized;
}

function isTableRow(line) {
  const trimmed = String(line || "").trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && countMatches(trimmed, /\|/g) >= 3;
}

function parseTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function padTableRow(row, columnCount) {
  const padded = row.slice(0, columnCount);
  while (padded.length < columnCount) padded.push("");
  return padded;
}

function formatTableRow(row) {
  return `| ${row.join(" | ")} |`;
}

function formatTableSeparator(columnCount) {
  return formatTableRow(Array.from({ length: columnCount }, () => "---"));
}

function isTableSeparatorRow(row) {
  return row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

async function createOcrOverlayPdf(sourcePdfData, result, mode) {
  const { PDFDocument, StandardFonts, rgb } = getPdfLib();
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
      drawPositionedInvisibleText({ page, font, lines, pageWidth: width, pageHeight: height, rgb });
    } else {
      const text = ocrPage?.text || pageTextFallback[pageIndex] || result.markdown || "";
      drawSearchableInvisibleText({ page, font, text, pageWidth: width, pageHeight: height, rgb });
    }
  }

  return pdfDoc.save({ useObjectStreams: false });
}

function drawPositionedInvisibleText({ page, font, lines, pageWidth, pageHeight, rgb }) {
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

function drawSearchableInvisibleText({ page, font, text, pageWidth, pageHeight, rgb }) {
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
  return String(text || "")
    .split(/\n+/)
    .flatMap((paragraph) => wrapParagraphForPdf(paragraph, maxChars));
}

function wrapParagraphForPdf(paragraph, maxChars) {
  const lines = [];
  let line = "";

  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (shouldWrapPdfLine(candidate, line, maxChars)) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function shouldWrapPdfLine(candidate, currentLine, maxChars) {
  return Boolean(currentLine) && candidate.length > maxChars;
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

function normalizeActionItemTag(value) {
  const tag = String(value || "").trim().replace(/\s+/g, "");
  if (!tag) return "";
  const normalized = tag.startsWith("#") ? tag : `#${tag}`;
  return normalized.replace(/[^#A-Za-z0-9/_-]/g, "");
}

function normalizeDate(value) {
  const match = String(value || "").match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return match ? match[0] : "";
}

function formatNoteTitle(format, { date, title }) {
  const template = String(format || DEFAULT_SETTINGS.noteTitleFormat).trim() || DEFAULT_SETTINGS.noteTitleFormat;
  const formatted = template
    .replace(/\bYYYY-MM-DD\b/g, date)
    .replace(/\bNoteTitle\b/g, title);
  return sanitizeTitle(formatted);
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

function createTimingTracker() {
  const startedAt = nowMs();
  let lastMark = startedAt;
  const stages = [];

  return {
    mark(stage) {
      const current = nowMs();
      stages.push({
        stage,
        ms: Math.round(current - lastMark),
        totalMs: Math.round(current - startedAt)
      });
      lastMark = current;
    },
    summary() {
      return {
        totalMs: Math.round(nowMs() - startedAt),
        stages
      };
    }
  };
}

function logTimingSummary({ timings, model, ocrDetail, ocrOverlayMode, hasTextOverlay, structureHints, createOcrPdf }) {
  const summary = timings.summary();
  console.info("Handwriting PDF timing", {
    totalMs: summary.totalMs,
    model,
    ocrDetail,
    ocrOverlayMode,
    hasTextOverlay,
    structureHints: normalizeStructureHints(structureHints),
    createOcrPdf,
    stages: summary.stages
  });
}

function nowMs() {
  if (typeof performance !== "undefined" && performance.now) return performance.now();
  return Date.now();
}

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

HandwritingPdfPlugin.__testing = {
  analyzePdfSignals,
  buildThinkingConfig,
  buildExtractionPrompt,
  buildResponseSchema,
  cleanGeneratedTranscription,
  formatNoteTitle,
  getModelOptions,
  getOcrDetailLevel,
  getOcrPlan,
  hasExistingPdfTextLayer,
  normalizeGeneratedMarkdown,
  normalizeMarkdownTables,
  parseGeminiResponse
};

module.exports = HandwritingPdfPlugin;
