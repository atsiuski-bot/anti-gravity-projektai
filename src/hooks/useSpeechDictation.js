import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useSpeechDictation — feature-detected Web Speech API voice-to-text for a single textarea.
 *
 * Reduces the friction of naming a quick-work / call session on a phone outdoors: instead of
 * thumb-typing, the worker dictates and the recognised text is appended to the field, which
 * stays fully editable afterwards. The control that toggles this is hidden where the API is
 * unsupported (`supported === false`).
 *
 * Mechanism: each final recognition result is appended (with a single separating space) to the
 * live `value` of the passed textarea ref — never replacing what the worker already typed or
 * dictated. Interim results are ignored so the field only ever gains committed text; the worker
 * can still edit by hand at any time. Recognition is single-shot per start (`continuous = false`)
 * and `lang = 'lt-LT'`, matching the app's Lithuanian UI.
 *
 * Browser support caveat: SpeechRecognition is a Chromium/WebKit feature (Chrome, Edge, Android
 * Chrome, recent Safari). Firefox does not implement it, and some locked-down WebViews omit it —
 * hence the feature detection and the hidden-when-unsupported contract. Capture also requires a
 * secure context (https / localhost) and the user granting the microphone permission; a denial
 * surfaces through `onerror` and simply stops listening (no crash).
 *
 * @param {React.RefObject<HTMLTextAreaElement>} textareaRef - the field to append transcripts to.
 * @returns {{ supported: boolean, isListening: boolean, start: () => void, stop: () => void, toggle: () => void }}
 */
export function useSpeechDictation(textareaRef) {
    // Resolve the constructor once; its presence is our support signal. webkit-prefixed on
    // Safari and older Chromium, unprefixed elsewhere.
    const SpeechRecognitionCtor =
        typeof window !== 'undefined'
            ? window.SpeechRecognition || window.webkitSpeechRecognition
            : undefined;
    const supported = Boolean(SpeechRecognitionCtor);

    const [isListening, setIsListening] = useState(false);
    const recognitionRef = useRef(null);

    // Append a recognised chunk to whatever is currently in the field, keeping it editable.
    const appendTranscript = useCallback((text) => {
        const el = textareaRef?.current;
        if (!el || !text) return;
        const existing = el.value || '';
        const needsSpace = existing.length > 0 && !/\s$/.test(existing);
        el.value = `${existing}${needsSpace ? ' ' : ''}${text}`;
        // Notify any listeners (and keep an uncontrolled field self-consistent) that the value
        // changed programmatically; harmless for the ref-read submit paths used by the modals.
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [textareaRef]);

    const stop = useCallback(() => {
        const rec = recognitionRef.current;
        if (rec) {
            try { rec.stop(); } catch { /* already stopped */ }
        }
        setIsListening(false);
    }, []);

    const start = useCallback(() => {
        if (!supported || recognitionRef.current) return;
        const rec = new SpeechRecognitionCtor();
        rec.lang = 'lt-LT';
        rec.continuous = false;
        rec.interimResults = false;
        rec.maxAlternatives = 1;

        rec.onresult = (event) => {
            let finalText = '';
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
                const result = event.results[i];
                if (result.isFinal) finalText += result[0]?.transcript || '';
            }
            if (finalText.trim()) appendTranscript(finalText.trim());
        };
        // Recognition ended (silence timeout, stop(), or error) — clear the live flag and drop
        // the instance so the next start gets a clean recogniser.
        rec.onend = () => {
            recognitionRef.current = null;
            setIsListening(false);
        };
        rec.onerror = () => {
            recognitionRef.current = null;
            setIsListening(false);
        };

        recognitionRef.current = rec;
        try {
            rec.start();
            setIsListening(true);
        } catch {
            // start() throws if called while already running; treat as a no-op.
            recognitionRef.current = null;
            setIsListening(false);
        }
    }, [supported, SpeechRecognitionCtor, appendTranscript]);

    const toggle = useCallback(() => {
        if (isListening) stop();
        else start();
    }, [isListening, start, stop]);

    // Tear down on unmount so a recogniser never outlives its modal (and the mic is released).
    useEffect(() => () => {
        const rec = recognitionRef.current;
        if (rec) {
            rec.onresult = null;
            rec.onend = null;
            rec.onerror = null;
            try { rec.stop(); } catch { /* already stopped */ }
            recognitionRef.current = null;
        }
    }, []);

    return { supported, isListening, start, stop, toggle };
}
