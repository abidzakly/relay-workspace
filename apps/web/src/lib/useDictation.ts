import { useEffect, useRef, useState } from 'react';

/**
 * Voice dictation: the browser's Web Speech API, Indonesian by default.
 * `supported` is false where the API is missing (Firefox, some PWAs): callers hide the mic then.
 */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult:
    | ((ev: {
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type Ctor = new () => SpeechRecognitionLike;

const ctor = (): Ctor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export function useDictation(onText: (text: string) => void, lang = 'id-ID') {
  const [listening, setListening] = useState(false);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const cb = useRef(onText);
  cb.current = onText;
  const supported = ctor() !== null;

  useEffect(() => () => rec.current?.stop(), []);

  const toggle = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const C = ctor();
    if (!C) return;
    const r = new C();
    r.lang = lang;
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (ev) => {
      let text = '';
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i]!;
        if (res.isFinal) text += res[0]!.transcript;
      }
      if (text.trim()) cb.current(text.trim());
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };
  return { supported, listening, toggle };
}
