import { requestUrl } from "obsidian";

export const OPENROUTER_API_URL =
  "https://openrouter.ai/api/v1/chat/completions";


export const NO_SUGGESTION = "NO_SUGGESTION";

export const DEFAULT_SYSTEM_PROMPT = `You are an inline ghost-text assistant inside Obsidian for personal knowledge notes.

Your job is to produce exactly one piece of text that can be inserted at the cursor.

The user wants ideas that are useful and occasionally surprising, not generic autocomplete. Continue the note naturally, but make the continuation intellectually generative.

Rules:
- Output ONLY the text to insert at the cursor.
- Do not explain what you are doing.
- Do not wrap the answer in quotes.
- Do not repeat text already present before or after the cursor.
- Match the language, tone, and markdown style of the note.
- Keep it concise: usually one sentence, or one short list item if the context is a list.
- The text must be acceptable if the user presses Tab and inserts it directly.
- You may use one strong thinking move when it fits:
  - reveal a hidden assumption
  - ask a sharper question
  - give a counterexample
  - reframe the concept
  - connect it to a concrete use case
  - introduce a useful analogy
  - point out a productive tension
- If the context is code, a table, YAML, or a strict template, prioritize format correctness over creativity.
- If the context is only a greeting, a random fragment, or not enough to infer a note topic, output exactly: NO_SUGGESTION
- If there is not enough context to produce a valuable continuation, output exactly: NO_SUGGESTION

Style:
- Prefer specific insight over vague encouragement.
- Prefer compressed, high-signal wording.
- Avoid generic phrases like "this is important" unless followed by a concrete reason.`;

export interface CompletionRequestOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt?: string;
  reasoningEffort?: string;
  excludeReasoning?: boolean;
  httpReferer?: string;
  appTitle?: string;
}

export class CompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionError";
  }
}

function normalizeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return OPENROUTER_API_URL;
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/")) return `${trimmed}chat/completions`;
  return `${trimmed}/chat/completions`;
}

function getReasoningPreferences(options: CompletionRequestOptions) {
  const effort = options.reasoningEffort?.trim();
  if (!effort) return undefined;

  return {
    effort,
    exclude: options.excludeReasoning !== false,
  };
}

export async function fetchCompletion(
  options: CompletionRequestOptions,
  prefix: string,
  suffix: string
): Promise<string | null> {
  const systemPrompt = options.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  const userMessage = `<before_cursor>
${prefix}
</before_cursor>

<after_cursor>
${suffix}
</after_cursor>

Return only the text to insert at the cursor. Do not repeat text that already appears before or after the cursor.`;

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    };

    if (options.httpReferer?.trim()) {
      headers["HTTP-Referer"] = options.httpReferer.trim();
    }

    if (options.appTitle?.trim()) {
      headers["X-OpenRouter-Title"] = options.appTitle.trim();
    }

    const reasoning = getReasoningPreferences(options);

    const response = await requestUrl({
      url: normalizeChatCompletionsUrl(options.baseUrl),
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        ...(reasoning ? { reasoning } : {}),
        max_tokens: 150,
        temperature: 0.3,
        stop: ["\n\n", "---"],
      }),
    });

    const data = response.json;
    if (data?.error?.message) {
      throw new CompletionError(String(data.error.message));
    }

    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    const normalizedText = text.replace(/^["']|["']$/g, "").trim();
    if (!normalizedText || normalizedText.toUpperCase() === NO_SUGGESTION) {
      return null;
    }
    return normalizedText;
  } catch (e) {
    if (e instanceof CompletionError) throw e;
    if (e instanceof Error) {
      throw new CompletionError(e.message);
    }
    throw new CompletionError("Unknown completion error");
  }
}
