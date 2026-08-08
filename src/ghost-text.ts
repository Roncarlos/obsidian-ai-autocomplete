import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
  keymap,
} from "@codemirror/view";
import {
  StateEffect,
  StateField,
  Text,
  Prec,
  EditorState,
  EditorSelection,
  TransactionSpec,
} from "@codemirror/state";
import { PLUGIN_NAME } from "./constants";

// --- State Management ---

export const InlineSuggestionEffect = StateEffect.define<{
  text: string | null;
  doc: Text;
}>();

export const ClearSuggestionEffect = StateEffect.define<null>();

export const InlineSuggestionState = StateField.define<{
  suggestion: string | null;
}>({
  create() {
    return { suggestion: null };
  },
  update(value, tr) {
    // Explicit clear
    for (const effect of tr.effects) {
      if (effect.is(ClearSuggestionEffect)) {
        return { suggestion: null };
      }
    }

    // New suggestion arrived
    for (const effect of tr.effects) {
      if (effect.is(InlineSuggestionEffect)) {
        // Only accept if doc hasn't changed since request
        if (tr.state.doc === effect.value.doc) {
          return { suggestion: effect.value.text };
        }
      }
    }

    // Any doc change or cursor move clears suggestion
    if (tr.docChanged || tr.selection) {
      return { suggestion: null };
    }

    return value;
  },
});

// --- Ghost Text Widget ---

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostTextWidget) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "ai-note-completion-ghost-text";
    span.textContent = this.text;
    return span;
  }

  get lineBreaks() {
    return this.text.split("\n").length - 1;
  }
}

// --- Render Plugin ---

const renderGhostTextPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;

    update(update: ViewUpdate) {
      const suggestion =
        update.state.field(InlineSuggestionState)?.suggestion;

      if (!suggestion) {
        this.decorations = Decoration.none;
        return;
      }

      const pos = update.state.selection.main.head;
      const widget = Decoration.widget({
        widget: new GhostTextWidget(suggestion),
        side: 1,
      });
      this.decorations = Decoration.set([widget.range(pos)]);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// --- Key Bindings ---

function insertCompletionText(
  state: EditorState,
  text: string,
  from: number,
  to: number
): TransactionSpec {
  return {
    ...state.changeByRange((range) => {
      if (range === state.selection.main) {
        return {
          changes: { from, to, insert: text },
          range: EditorSelection.cursor(from + text.length),
        };
      }
      return { range };
    }),
    userEvent: "input.complete",
  };
}

const ghostTextKeymap = Prec.highest(
  keymap.of([
    {
      key: "Tab",
      run: (view: EditorView) => {
        const suggestion =
          view.state.field(InlineSuggestionState)?.suggestion;
        if (!suggestion) return false;

        const head = view.state.selection.main.head;
        view.dispatch(insertCompletionText(view.state, suggestion, head, head));
        return true;
      },
    },
    {
      key: "Escape",
      run: (view: EditorView) => {
        const suggestion =
          view.state.field(InlineSuggestionState)?.suggestion;
        if (!suggestion) return false;

        view.dispatch({ effects: ClearSuggestionEffect.of(null) });
        return true;
      },
    },
  ])
);

// --- Fetch Plugin (triggers AI completion) ---

export type FetchFn = (
  prefix: string,
  suffix: string,
  state: EditorState
) => Promise<string | null>;

export function createFetchPlugin(fetchFn: FetchFn, delay: number) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private abortController: AbortController | null = null;

      update(update: ViewUpdate) {
        if (!update.docChanged) return;

        // Cancel pending request
        if (this.timer) clearTimeout(this.timer);
        if (this.abortController) this.abortController.abort();

        this.timer = setTimeout(() => {
          void (async () => {
            const doc = update.state.doc;
            const cursor = update.state.selection.main.head;
            const fullText = doc.toString();

            const prefix = fullText.slice(Math.max(0, cursor - 2000), cursor);
            const suffix = fullText.slice(cursor, cursor + 500);

            // Don't trigger on empty or very short prefix
            if (prefix.trim().length < 3) return;

            this.abortController = new AbortController();

            try {
              const result = await fetchFn(prefix, suffix, update.state);
              if (result && result.trim()) {
                update.view.dispatch({
                  effects: InlineSuggestionEffect.of({
                    text: result,
                    doc,
                  }),
                });
              }
            } catch (e) {
              // Silently ignore aborted requests
              if (e instanceof Error && e.name !== "AbortError") {
                console.error(`${PLUGIN_NAME}: fetch error`, e);
              }
            }
          })();
        }, delay);
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer);
        if (this.abortController) this.abortController.abort();
      }
    }
  );
}

// --- Public API ---

export function inlineSuggestionExtension(fetchFn: FetchFn, delay = 800) {
  return [
    InlineSuggestionState,
    createFetchPlugin(fetchFn, delay),
    renderGhostTextPlugin,
    ghostTextKeymap,
  ];
}
