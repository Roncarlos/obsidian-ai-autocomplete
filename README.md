# AI Autocomplete

AI inline writing completion for Obsidian, powered by OpenAI-compatible APIs. The default setup routes through [OpenRouter](https://openrouter.ai).

Type naturally and get ghost text suggestions that appear inline. Press **Tab** to accept, **Esc** to dismiss.

## Features

- **Ghost text completion** — transparent suggestions appear at your cursor, like GitHub Copilot
- **Context-aware** — reads text before and after cursor for coherent continuations
- **Insight-oriented** — can surface sharper questions, hidden assumptions, analogies, and reframes for personal knowledge notes
- **Fast** — uses compact requests and low-latency model defaults
- **Bilingual** — automatically detects and continues in Chinese or English
- **Lightweight** — 6KB plugin, no dependencies

## Usage

1. Install the plugin
2. Go to Settings → AI Autocomplete → enter your OpenRouter API key
3. Start writing — suggestions appear after a brief pause

| Key | Action |
|-----|--------|
| Tab | Accept suggestion |
| Esc | Dismiss suggestion |
| Keep typing | Suggestion auto-dismisses |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| API base URL | `https://openrouter.ai/api/v1/chat/completions` | Any OpenAI-compatible chat completions endpoint |
| Model | `openai/gpt-oss-120b:nitro` | Smart default via OpenRouter |
| System prompt | Built-in heuristic prompt | Editable prompt that controls ghost text style and insight behavior |
| Reasoning effort | `minimal` | Keeps reasoning models fast enough for inline autocomplete |
| Hide reasoning | On | Excludes reasoning tokens from suggestion text |
| Trigger delay | 800ms | How long to wait after typing before fetching a suggestion |
| Enabled | On | Toggle via settings or command palette |

## How it works

The plugin uses CodeMirror 6 extensions to render transparent "ghost text" at the cursor position. When you pause typing, it sends the surrounding context (up to 2000 chars before + 500 chars after cursor) to the configured API and displays the completion as inline ghost text.

## License

MIT
