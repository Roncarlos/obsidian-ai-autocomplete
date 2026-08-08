import { Plugin, PluginSettingTab, App, Setting, Notice } from "obsidian";
import { Extension } from "@codemirror/state";
import { inlineSuggestionExtension } from "./ghost-text";
import { buildObsidianLinkContext } from "./obsidian-links";
import {
  AIProvider,
  CompletionError,
  CompletionRequestOptions,
  DEFAULT_SYSTEM_PROMPT,
  fetchCompletion,
  fetchLMStudioModels,
  LMStudioModel,
  ModelDiscoveryError,
  OPENROUTER_API_URL,
  ReasoningMode,
} from "./api";

const LM_STUDIO_API_URL = "http://localhost:1234/v1/chat/completions";

interface AIAutocompleteSettings {
  provider: AIProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  reasoningByModel: Record<string, ReasoningMode>;
  excludeReasoning: boolean;
  httpReferer: string;
  appTitle: string;
  delay: number;
  enabled: boolean;
  /** Legacy field kept readable so older data can be migrated safely. */
  reasoningEffort?: string;
}

const DEFAULT_SETTINGS: AIAutocompleteSettings = {
  provider: "openrouter",
  apiKey: "",
  model: "openai/gpt-oss-120b:nitro",
  baseUrl: OPENROUTER_API_URL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  reasoningByModel: {},
  excludeReasoning: true,
  httpReferer: "https://github.com/Leoyishou/obsidian-ai-autocomplete",
  appTitle: "AI Autocomplete",
  delay: 800,
  enabled: true,
};

const ALL_REASONING_MODES: ReasoningMode[] = [
  "auto",
  "disabled",
  "low",
  "medium",
  "high",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProvider(value: unknown): value is AIProvider {
  return value === "openrouter" || value === "lmstudio";
}

function isReasoningMode(value: unknown): value is ReasoningMode {
  return ALL_REASONING_MODES.includes(value as ReasoningMode);
}

function migrateReasoningMode(value: unknown): ReasoningMode {
  if (typeof value !== "string") return "disabled";

  switch (value.trim().toLowerCase()) {
    case "":
      return "auto";
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "none":
    case "disabled":
    case "off":
      return "disabled";
    case "auto":
    case "on":
      return "auto";
    default:
      return "disabled";
  }
}

function normalizeReasoningByModel(value: unknown) {
  const result: Record<string, ReasoningMode> = {};
  if (!isRecord(value)) return result;

  for (const model of Object.keys(value)) {
    const mode = value[model];
    if (model.trim()) result[model] = migrateReasoningMode(mode);
  }
  return result;
}

function looksLikeLMStudioUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    const url = new URL(value);
    return (
      /\/api\/v1\/chat\/completions\/?$/.test(url.pathname) ||
      url.port === "1234" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function reasoningModeLabel(mode: ReasoningMode): string {
  switch (mode) {
    case "auto":
      return "Automatic";
    case "disabled":
      return "Disabled";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
  }
}

function formatModelOptionLabel(model: LMStudioModel, id: string): string {
  return id === model.id ? model.displayName : `${model.displayName} (${id})`;
}

export default class AIAutocompletePlugin extends Plugin {
  settings: AIAutocompleteSettings = { ...DEFAULT_SETTINGS };
  private editorExtensions: Extension[] = [];
  private lastErrorNoticeAt = 0;
  private lmStudioModels: LMStudioModel[] = [];
  private lmStudioModelsUrl = "";
  private lmStudioModelsError = "";
  private lmStudioModelsLoading = false;
  private lmStudioModelsRequest: Promise<LMStudioModel[]> | null = null;
  private lmStudioRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private settingTab: AIAutocompleteSettingTab | undefined;

  async onload() {
    await this.loadSettings();

    if (this.settings.provider === "lmstudio") {
      void this.refreshLMStudioModels();
    }

    this.editorExtensions = inlineSuggestionExtension(
      async (prefix, suffix) => {
        if (
          !this.settings.enabled ||
          (this.settings.provider !== "lmstudio" && !this.settings.apiKey)
        ) {
          return null;
        }
        try {
          const activeFile = this.app.workspace.getActiveFile();
          let linkedContext = "";
          if (activeFile) {
            try {
              linkedContext = await buildObsidianLinkContext(
                this.app,
                activeFile,
                `${prefix}\n${suffix}`
              );
            } catch (error) {
              console.warn(
                "AI autocomplete: unable to read internal links",
                error
              );
            }
          }
          return await fetchCompletion(
            {
              ...this.getCompletionOptions(),
              linkedContext,
            },
            prefix,
            suffix
          );
        } catch (e) {
          this.showCompletionError(e);
          return null;
        }
      },
      this.settings.delay
    );

    this.registerEditorExtension(this.editorExtensions);

    this.addCommand({
      id: "toggle",
      name: "Toggle auto-completion",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.saveSettings();
        new Notice(
          `AI autocomplete: ${this.settings.enabled ? "on" : "off"}`
        );
      },
    });

    this.addCommand({
      id: "test-connection",
      name: "Test connection",
      callback: () => {
        void this.testConnection();
      },
    });

    this.settingTab = new AIAutocompleteSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
  }

  async loadSettings() {
    const loadedData = await this.loadData();
    const stored = isRecord(loadedData) ? loadedData : {};
    const storedModel =
      typeof stored.model === "string" && stored.model.trim()
        ? stored.model
        : DEFAULT_SETTINGS.model;
    const storedBaseUrl =
      typeof stored.baseUrl === "string" && stored.baseUrl.trim()
        ? stored.baseUrl
        : DEFAULT_SETTINGS.baseUrl;
    const provider = isProvider(stored.provider)
      ? stored.provider
      : looksLikeLMStudioUrl(storedBaseUrl)
        ? "lmstudio"
        : DEFAULT_SETTINGS.provider;
    const reasoningByModel = normalizeReasoningByModel(
      stored.reasoningByModel
    );

    if (
      Object.keys(reasoningByModel).length === 0 &&
      Object.prototype.hasOwnProperty.call(stored, "reasoningEffort")
    ) {
      reasoningByModel[storedModel] = migrateReasoningMode(
        stored.reasoningEffort
      );
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored, {
      provider,
      model: storedModel,
      baseUrl: storedBaseUrl,
      reasoningByModel,
    }) as AIAutocompleteSettings;

    const shouldPersistMigration =
      stored.provider !== provider ||
      !Object.prototype.hasOwnProperty.call(stored, "reasoningByModel") ||
      Object.prototype.hasOwnProperty.call(stored, "reasoningEffort");
    if (shouldPersistMigration) await this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getCompletionOptions(): CompletionRequestOptions {
    return {
      apiKey: this.settings.apiKey,
      model: this.settings.model,
      baseUrl: this.settings.baseUrl,
      provider: this.settings.provider,
      systemPrompt: this.settings.systemPrompt,
      reasoningMode: this.getReasoningMode(),
      excludeReasoning: this.settings.excludeReasoning,
      httpReferer: this.settings.httpReferer,
      appTitle: this.settings.appTitle,
    };
  }

  getReasoningMode(model = this.settings.model): ReasoningMode {
    const storedMode = this.settings.reasoningByModel[model];
    const mode = storedMode || "disabled";
    if (this.settings.provider !== "lmstudio") return mode;

    return this.getAvailableReasoningModes(model).includes(mode)
      ? mode
      : "disabled";
  }

  getLMStudioModel(modelId = this.settings.model): LMStudioModel | undefined {
    return this.lmStudioModels.find(
      (model) =>
        model.id === modelId ||
        model.variants.some((variant) => variant === modelId)
    );
  }

  getLMStudioModelOptions() {
    const options: Array<{ value: string; label: string }> = [];
    const seen = new Set<string>();

    for (const model of this.lmStudioModels) {
      for (const id of [model.id, ...model.variants]) {
        if (seen.has(id)) continue;
        seen.add(id);
        options.push({ value: id, label: formatModelOptionLabel(model, id) });
      }
    }

    if (this.settings.model && !seen.has(this.settings.model)) {
      options.push({
        value: this.settings.model,
        label: "Custom current model",
      });
    }
    return options;
  }

  getAvailableReasoningModes(modelId = this.settings.model): ReasoningMode[] {
    if (this.settings.provider !== "lmstudio") return ALL_REASONING_MODES;

    const model = this.getLMStudioModel(modelId);
    const modes = new Set<ReasoningMode>(["disabled"]);
    for (const mode of model?.reasoningAllowedOptions || []) {
      modes.add(mode);
    }
    return ALL_REASONING_MODES.filter((mode) => modes.has(mode));
  }

  getReasoningDescription(): string {
    if (this.settings.provider !== "lmstudio") {
      return "Automatic omits the provider-specific reasoning parameter; Disabled requests no reasoning when supported.";
    }

    const model = this.getLMStudioModel();
    if (!model) {
      return "Capabilities are unknown for this custom model. Disabled is used for LM Studio autocomplete.";
    }
    if (model.reasoningAllowedOptions.length === 0) {
      return "LM Studio declares no reasoning options for this model. Disabled is used.";
    }

    const allowed = model.reasoningAllowedOptions
      .map(reasoningModeLabel)
      .join(", ");
    const defaultValue = model.reasoningDefault
      ? ` Default reported by LM Studio: ${reasoningModeLabel(model.reasoningDefault)}.`
      : "";
    return `Available according to LM Studio: ${allowed}.${defaultValue} Reasoning stays disabled in autocomplete requests.`;
  }

  getModelError(): string {
    return this.lmStudioModelsError;
  }

  isLMStudioModelsLoading(): boolean {
    return this.lmStudioModelsLoading;
  }

  hasLMStudioModelCache(): boolean {
    return this.lmStudioModelsUrl === this.settings.baseUrl.trim();
  }

  async refreshLMStudioModels(
    force = false,
    showNotice = false
  ): Promise<LMStudioModel[]> {
    if (this.settings.provider !== "lmstudio") return this.lmStudioModels;

    const cacheKey = this.settings.baseUrl.trim();
    if (!force && this.hasLMStudioModelCache() && this.lmStudioModels.length) {
      return this.lmStudioModels;
    }
    if (this.lmStudioModelsRequest) return this.lmStudioModelsRequest;

    this.lmStudioModelsLoading = true;
    this.lmStudioModelsError = "";
    this.refreshSettingTab();

    const request = fetchLMStudioModels({
      apiKey: this.settings.apiKey,
      baseUrl: this.settings.baseUrl,
    });
    this.lmStudioModelsRequest = request;

    try {
      const models = await request;
      this.lmStudioModels = models;
      this.lmStudioModelsUrl = cacheKey;
      return models;
    } catch (error) {
      const message =
        error instanceof ModelDiscoveryError || error instanceof Error
          ? error.message
          : "Unable to load LM Studio models.";
      this.lmStudioModelsError = message;
      // Remember the failed URL so opening the settings tab does not retry in a loop.
      this.lmStudioModelsUrl = cacheKey;
      if (showNotice) new Notice(`AI autocomplete: ${message}`);
      return this.lmStudioModels;
    } finally {
      this.lmStudioModelsLoading = false;
      this.lmStudioModelsRequest = null;
      this.refreshSettingTab();
    }
  }

  async updateProvider(provider: AIProvider) {
    if (this.settings.provider === provider) return;

    const wasUsingDefaultOpenRouterUrl =
      this.settings.baseUrl.trim() === OPENROUTER_API_URL;
    this.settings.provider = provider;
    if (provider === "lmstudio" && wasUsingDefaultOpenRouterUrl) {
      this.settings.baseUrl = LM_STUDIO_API_URL;
    }
    this.invalidateLMStudioModelCache();
    await this.saveSettings();

    if (provider === "lmstudio") void this.refreshLMStudioModels();
  }

  async updateBaseUrl(value: string) {
    this.settings.baseUrl = value;
    if (this.settings.provider === "lmstudio") {
      this.invalidateLMStudioModelCache();
      this.scheduleLMStudioModelRefresh();
    }
    await this.saveSettings();
  }

  async updateModel(value: string) {
    this.settings.model = value.trim();
    await this.saveSettings();
  }

  async selectModel(value: string) {
    await this.updateModel(value);
  }

  async updateReasoningMode(value: string) {
    if (!isReasoningMode(value)) return;
    if (!this.getAvailableReasoningModes().includes(value)) return;
    this.settings.reasoningByModel[this.settings.model] = value;
    await this.saveSettings();
  }

  private invalidateLMStudioModelCache() {
    this.lmStudioModels = [];
    this.lmStudioModelsUrl = "";
    this.lmStudioModelsError = "";
  }

  private scheduleLMStudioModelRefresh() {
    if (this.lmStudioRefreshTimer) clearTimeout(this.lmStudioRefreshTimer);
    this.lmStudioRefreshTimer = setTimeout(() => {
      this.lmStudioRefreshTimer = undefined;
      void this.refreshLMStudioModels();
    }, 500);
  }

  private refreshSettingTab() {
    this.settingTab?.display();
  }

  async testConnection() {
    if (this.settings.provider !== "lmstudio" && !this.settings.apiKey) {
      new Notice("AI autocomplete: API key is empty");
      return;
    }

    try {
      const result = await fetchCompletion(
        this.getCompletionOptions(),
        "个人知识笔记的真正价值在于",
        ""
      );
      new Notice(`AI autocomplete: connected${result ? ` (${result})` : ""}`);
    } catch (e) {
      this.showCompletionError(e, true);
    }
  }

  showCompletionError(error: unknown, forceNotice = false) {
    console.error("AI autocomplete: completion error", error);

    const now = Date.now();
    if (!forceNotice && now - this.lastErrorNoticeAt < 10000) return;
    this.lastErrorNoticeAt = now;

    const message =
      error instanceof CompletionError || error instanceof Error
        ? error.message
        : "Unknown completion error";
    new Notice(`AI autocomplete failed: ${message}`);
  }
}

class AIAutocompleteSettingTab extends PluginSettingTab {
  plugin: AIAutocompletePlugin;

  constructor(app: App, plugin: AIAutocompletePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Choose which OpenAI-compatible provider handles completions")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("openrouter", "OpenRouter")
          .addOption("lmstudio", "LM Studio")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            if (isProvider(value)) {
              await this.plugin.updateProvider(value);
              this.display();
            }
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc(
        this.plugin.settings.provider === "lmstudio"
          ? "Optional Bearer token for LM Studio"
          : "Use this key for the default provider route"
      )
      .addText((text) =>
        text
          .setPlaceholder("Enter your API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("Chat completions endpoint")
      .addText((text) =>
        text
          .setPlaceholder(
            this.plugin.settings.provider === "lmstudio"
              ? LM_STUDIO_API_URL
              : OPENROUTER_API_URL
          )
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            await this.plugin.updateBaseUrl(value);
          })
      );

    this.addModelSetting(containerEl);

    new Setting(containerEl)
      .setName("Reasoning effort")
      .setDesc(this.plugin.getReasoningDescription())
      .addDropdown((dropdown) => {
        for (const mode of this.plugin.getAvailableReasoningModes()) {
          dropdown.addOption(mode, reasoningModeLabel(mode));
        }
        return dropdown
          .setValue(this.plugin.getReasoningMode())
          .onChange(async (value) => {
            await this.plugin.updateReasoningMode(value);
          });
      });

    new Setting(containerEl)
      .setName("Hide reasoning")
      .setDesc(
        "Only controls whether returned reasoning fields are shown; it does not disable reasoning computation"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.excludeReasoning)
          .onChange(async (value) => {
            this.plugin.settings.excludeReasoning = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Controls the writing style and insight behavior of ghost text")
      .addTextArea((text) => {
        text.inputEl.rows = 14;
        text.inputEl.cols = 64;
        text
          .setPlaceholder(DEFAULT_SYSTEM_PROMPT)
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Reset prompt")
      .setDesc("Restore the built-in heuristic prompt")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
          await this.plugin.saveSettings();
          this.display();
          new Notice("AI autocomplete: prompt reset");
        })
      );

    new Setting(containerEl)
      .setName("HTTP referer")
      .setDesc("Optional app attribution")
      .addText((text) =>
        text
          .setPlaceholder("Enter a referer URL")
          .setValue(this.plugin.settings.httpReferer)
          .onChange(async (value) => {
            this.plugin.settings.httpReferer = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("App title")
      .setDesc("Optional app attribution")
      .addText((text) =>
        text
          .setPlaceholder("AI autocomplete")
          .setValue(this.plugin.settings.appTitle)
          .onChange(async (value) => {
            this.plugin.settings.appTitle = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Trigger delay (ms)")
      .setDesc("How long to wait after typing before triggering completion")
      .addSlider((slider) =>
        slider
          .setLimits(300, 2000, 100)
          .setValue(this.plugin.settings.delay)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.delay = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enabled")
      .setDesc("Toggle auto-completion on/off")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Send a short test request with the current settings")
      .addButton((button) =>
        button.setButtonText("Test").onClick(() => {
          void this.plugin.testConnection();
        })
      );

    if (
      this.plugin.settings.provider === "lmstudio" &&
      !this.plugin.hasLMStudioModelCache() &&
      !this.plugin.isLMStudioModelsLoading()
    ) {
      void this.plugin.refreshLMStudioModels();
    }
  }

  private addModelSetting(containerEl: HTMLElement) {
    const isLMStudio = this.plugin.settings.provider === "lmstudio";
    const currentModel = this.plugin.settings.model;
    const descriptionParts = [
      isLMStudio
        ? "Select an LM Studio model or edit the exact identifier sent to the API"
        : "Model identifier sent to the API",
    ];
    const modelError = this.plugin.getModelError();
    if (modelError) descriptionParts.push(`Error: ${modelError}`);

    const setting = new Setting(containerEl)
      .setName("Model")
      .setDesc(descriptionParts.join(". "));

    if (isLMStudio) {
      setting.addDropdown((dropdown) => {
        const options = this.plugin.getLMStudioModelOptions();
        if (options.length === 0) {
          dropdown.addOption("", "No models loaded");
        } else {
          for (const option of options) {
            dropdown.addOption(option.value, option.label);
          }
        }
        return dropdown
          .setValue(currentModel)
          .onChange(async (value) => {
            if (!value) return;
            await this.plugin.selectModel(value);
            this.display();
          });
      });
    }

    setting.addText((text) =>
      text
        .setPlaceholder("Enter a model identifier")
        .setValue(currentModel)
        .onChange(async (value) => {
          await this.plugin.updateModel(value);
        })
    );

    if (isLMStudio) {
      setting.addButton((button) => {
        button
          .setButtonText(
            this.plugin.isLMStudioModelsLoading()
              ? "Loading…"
              : this.plugin.hasLMStudioModelCache()
                ? "Refresh models"
                : "Load models"
          )
          .onClick(() => {
            void this.plugin.refreshLMStudioModels(true, true);
          });
        if (this.plugin.isLMStudioModelsLoading()) button.setDisabled(true);
        return button;
      });
    }
  }
}
