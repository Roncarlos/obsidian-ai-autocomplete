# AI Note Completion

AI inline writing completion for Obsidian, powered by OpenAI-compatible APIs. The default setup routes through [OpenRouter](https://openrouter.ai).

Type naturally and get ghost text suggestions that appear inline. Press **Tab** to accept, **Esc** to dismiss.

## Features

- **Ghost text completion** — transparent suggestions appear at your cursor, like GitHub Copilot
- **Context-aware** — reads text before and after cursor for coherent continuations
- **Insight-oriented** — can surface sharper questions, hidden assumptions, analogies, and reframes for personal knowledge notes
- **Internal-link context** — resolves linked notes, headings, and blocks so suggestions can use their content
- **Fast** — uses compact requests and low-latency model defaults
- **Bilingual** — automatically detects and continues in Chinese or English
- **Lightweight** — 6KB plugin, no dependencies

## Usage

1. Install the plugin
2. Go to Settings → AI Note Completion → enter your OpenRouter API key
3. Start writing — suggestions appear after a brief pause

| Key | Action |
|-----|--------|
| Tab | Accept suggestion |
| Esc | Dismiss suggestion |
| Keep typing | Suggestion auto-dismisses |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Provider | `OpenRouter` | Select OpenRouter or LM Studio |
| API base URL | `https://openrouter.ai/api/v1/chat/completions` | Any OpenAI-compatible chat completions endpoint; LM Studio model discovery uses `/api/v1/models` |
| Model | `openai/gpt-oss-120b:nitro` | Model identifier sent to the selected provider; LM Studio offers a discovered list and custom values |
| System prompt | Built-in heuristic prompt | Editable prompt that controls ghost text style and insight behavior |
| Reasoning effort | `disabled` | Stored separately for each model; LM Studio autocomplete always sends `reasoning_effort: "none"` and `reasoning_tokens: 0` |
| Hide reasoning | On | Controls visibility of returned reasoning fields; it does not disable computation |
| Trigger delay | 800ms | How long to wait after typing before fetching a suggestion |
| Enabled | On | Toggle via settings or command palette |

## How it works

The plugin uses CodeMirror 6 extensions to render transparent "ghost text" at the cursor position. When you pause typing, it sends the surrounding context (up to 2000 chars before + 500 chars after cursor) to the configured API and displays the completion as inline ghost text.

Internal Obsidian links found in that context are resolved automatically. The plugin supports whole notes (`[[Note]]`), headings (`[[Note#Heading]]`), blocks (`[[Note#^block-id]]`), and same-note references (`[[#Heading]]`). Aliases and embeds are also recognized. Standard Markdown web links are ignored. At most 8 unique references, 3000 characters per reference, and 10000 characters in total are added to a request.

Reference-handling rules remain in the system prompt, while linked-note excerpts are sent as user-level reference data. Each excerpt is labeled with its source, scope (`note`, `section`, or `block`), and truncation status so smaller models can apply it more reliably.

When LM Studio is selected, the plugin loads language models from `/api/v1/models` at startup and provides a manual refresh action in settings. The selected model's reasoning capabilities and declared default are shown in the settings. A custom model identifier can always be entered manually.

## Attribution

This project is a continued version of [AI Autocomplete](https://github.com/Leoyishou/obsidian-ai-autocomplete), originally created by Leoyishou. The original MIT license and copyright notice are preserved.

## License

MIT
