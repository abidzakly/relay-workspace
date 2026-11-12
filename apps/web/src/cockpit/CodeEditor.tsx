import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import { dart } from '@codemirror/legacy-modes/mode/clike';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { useMemo } from 'react';

/** Language by extension. Dart / YAML via legacy modes (no first-party CM6 package). */
function langFor(path: string): Extension[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'dart') return [StreamLanguage.define(dart)];
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext))
    return [javascript({ typescript: ext.startsWith('t'), jsx: ext.endsWith('x') })];
  if (ext === 'json' || ext === 'arb') return [json()];
  if (ext === 'md') return [markdown()];
  if (ext === 'yaml' || ext === 'yml') return [StreamLanguage.define(yaml)];
  return [];
}

/**
 * Minimal editor: CodeMirror 6, light on phones. Follows the app theme
 * (`prefers-color-scheme` / `.dark`).
 */
export default function CodeEditor({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const extensions = useMemo(() => [...langFor(path), EditorView.lineWrapping], [path]);
  const dark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-xl border text-sm">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme={dark ? 'dark' : 'light'}
        height="100%"
        style={{ height: '100%' }}
        basicSetup={{ foldGutter: false, highlightActiveLineGutter: true }}
      />
    </div>
  );
}
