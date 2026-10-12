import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { useStore } from './store';

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'html' || label === 'xml') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
monaco.editor.defineTheme('workbench-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '99B9EA' },
    { token: 'string.value.json', foreground: '9FD0A2' },
  ],
  colors: {
    'editor.background': '#191b20',
    'editor.lineHighlightBackground': '#20232a',
    'editorLineNumber.foreground': '#626979',
    'editor.selectionBackground': '#294d78',
    'editorGutter.background': '#191b20',
  },
});
monaco.editor.defineTheme('workbench-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#ffffff', 'editorGutter.background': '#ffffff' },
});
export function CodeEditor({
  value,
  onChange,
  language = 'json',
  readOnly = false,
  height = '100%',
  label = 'Code editor',
}: {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  height?: string | number;
  label?: string;
}) {
  const theme = useStore((s) => s.data.settings.theme);
  return (
    <div className="code-editor" style={{ height }} aria-label={label}>
      <Editor
        height="100%"
        value={value}
        language={language === 'text' ? 'plaintext' : language}
        theme={`workbench-${theme}`}
        onChange={(v) => onChange?.(v || '')}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 12,
          fontFamily: "'Cascadia Code', Consolas, monospace",
          lineHeight: 21,
          padding: { top: 12, bottom: 12 },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
          tabSize: 2,
          folding: true,
          renderLineHighlight: 'none',
          contextmenu: true,
          bracketPairColorization: { enabled: true },
          ariaLabel: label,
          scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
        }}
        loading={<div className="editor-loading">Loading editor…</div>}
      />
    </div>
  );
}
