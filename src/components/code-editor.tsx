"use client";

import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

export type EditorLanguage = "json" | "xml" | "text";

/** What `{{` offers. Kept next to the editor so the list is easy to extend. */
const HELPERS: { label: string; detail: string; apply?: string }[] = [
  { label: "request.params.", detail: "path parameter" },
  { label: "request.query.", detail: "query string value" },
  { label: "request.headers.", detail: "request header (lower-case)" },
  { label: "request.body.", detail: "parsed request body" },
  { label: "vars.", detail: "project variable" },
  { label: "uuid", detail: "random UUID" },
  { label: "now", detail: "current ISO timestamp" },
  { label: "json ", detail: "valid JSON for a value", apply: "json " },
  { label: "xml ", detail: "XML-escaped value (SOAP)", apply: "xml " },
  { label: "randomInt 1 100", detail: "random integer" },
  { label: 'faker "person.fullName"', detail: "fake data" },
  { label: "sum request.body.items \"price\"", detail: "sum a field over an array" },
  { label: "#repeat 3", detail: "repeat a block (close with {{/repeat}})" },
  { label: 'soapFault "Client" "message"', detail: "SOAP Fault (status 500)" },
];

function templateCompletions(ctx: CompletionContext) {
  const m = ctx.matchBefore(/\{\{[#/]?[\w.$ "]*$/);
  if (!m || (m.from === m.to && !ctx.explicit)) return null;
  const typed = m.text.replace(/^\{\{/, "");
  return {
    from: m.from + 2,
    options: HELPERS.filter((h) => h.label.replace(/^#/, "").startsWith(typed.replace(/^#/, ""))).map((h) => ({ label: h.label, detail: h.detail, apply: h.apply ?? h.label, type: "function" })),
    validFor: /^[#/\w.$ "]*$/,
  };
}

const language = (l: EditorLanguage): Extension => (l === "json" ? json() : l === "xml" ? xml() : []);

const baseTheme = EditorView.theme({
  "&": { fontSize: "13px", borderRadius: "6px", border: "1px solid var(--cm-border, #d4d4d8)" },
  "&.cm-focused": { outline: "1px solid #6366f1", borderColor: "#6366f1" },
  ".cm-scroller": { fontFamily: "var(--font-geist-mono), ui-monospace, monospace", lineHeight: "1.4rem" },
});

/**
 * A bundled (offline) code editor: highlighting for JSON/XML, bracket matching, `{{` helper completion.
 * Controlled: `value` in, `onChange` out. Ctrl+S is left to the surrounding card.
 */
export function CodeEditor({ value, onChange, language: lang = "text", minRows = 8, label }: { value: string; onChange: (v: string) => void; language?: EditorLanguage; minRows?: number; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langSlot = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          baseTheme,
          dark ? oneDark : [],
          langSlot.current.of(language(lang)),
          autocompletion({ override: [templateCompletions] }),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.theme({ ".cm-content, .cm-gutter": { minHeight: `${minRows * 1.4}rem` } }),
          EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // The editor is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: langSlot.current.reconfigure(language(lang)) });
  }, [lang]);

  return <div ref={host} />;
}
