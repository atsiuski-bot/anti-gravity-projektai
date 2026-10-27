// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The sheet's own flow is under test: which choice pre-fills what, and which write each button
// reaches. Firestore, the notify funnel and the AI callable are stubs; the validators
// (deriveSessionFields / validateSelfReduction) are the REAL ones, so a pre-fill that the write
// layer would refuse fails here too.
vi.mock('../firebase', () => ({ db: {}, auth: {}, functions: {} }));
vi.mock('firebase/firestore', () => ({
    collection: vi.fn(() => ({})),
    query: vi.fn(() => ({})),
    where: vi.fn(() => ({})),
    getDocs: vi.fn(() => Promise.resolve({ docs: [{ id: 't9', data: () => ({ title: 'Tvora', assignedUserId: 'u1' }) }] })),
}));
vi.mock('../utils/notify', () => ({ notifyMany: vi.fn(() => Promise.resolve()) }));
vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));
// The AI kill switch is read at render time, so a getter lets one file cover both states: off (as
// shipped, D11) by default, on for the tests that pin the AI flow for when it is switched back on.
const ai = vi.hoisted(() => ({ enabled: false }));
vi.mock('../utils/aiActions', () => ({
    suggestTimeCorrection: vi.fn(),
    get AI_CALLABLES_ENABLED() { return ai.enabled; },
}));
vi.mock('../utils/sessionEditActions', async (importOriginal) => ({
    ...(await importOriginal()),
    reduceOwnWorkSession: vi.fn(() => Promise.resolve({ ok: true })),
}));

const { default: TimeCorrectionSheet } = await import('./TimeCorrectionSheet');
const { notifyMany } = await import('../utils/notify');
const { suggestTimeCorrection } = await import('../utils/aiActions');
const { reduceOwnWorkSession } = await import('../utils/sessionEditActions');

// Work day 2026-09-01 (summer, UTC+3). Local 08:00–09:00 on Stogas, a gap, then 10:30–12:00 on Tvora.
const DAY = '2026-09-01';
const works = [
    { id: 'w1', userId: 'u1', taskId: 't1', taskTitle: 'Stogas', startTime: '2026-09-01T05:00:00.000Z', endTime: '2026-09-01T06:00:00.000Z', durationMinutes: 60 },
    { id: 'w2', userId: 'u1', taskId: 't2', taskTitle: 'Tvora', startTime: '2026-09-01T07:30:00.000Z', endTime: '2026-09-01T09:00:00.000Z', durationMinutes: 90 },
];
const worker = { uid: 'u1', displayName: 'Jonas', email: 'j@x.lt', name: 'Jonas' };

const byText = (text) => [...document.body.querySelectorAll('button')].find((b) => b.textContent.includes(text));
const click = async (el) => { await act(async () => { el.click(); }); };
const setValue = async (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe('TimeCorrectionSheet', () => {
    let container;
    let root;

    const render = async (props = {}) => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root.render(
                <TimeCorrectionSheet
                    open
                    onClose={() => {}}
                    day={DAY}
                    worker={worker}
                    workRows={works}
                    breakRows={[]}
                    managerIds={['m1']}
                    adminUids={['a1']}
                    {...props}
                />
            );
        });
    };

    beforeEach(() => {
        global.IS_REACT_ACT_ENVIRONMENT = true;
        // jsdom has no matchMedia; the task Select reads it to pick its phone presentation.
        window.matchMedia = window.matchMedia || (() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
        vi.clearAllMocks();
    });
    afterEach(() => {
        act(() => root?.unmount());
        document.body.innerHTML = '';
        ai.enabled = false;
    });

    it('opens on five choices and nothing to type', async () => {
        await render();
        for (const label of ['Pamiršau paleisti laikmatį', 'Pamiršau sustabdyti laikmatį', 'Neteisingas laikas', 'Pauzė buvo darbas', 'Kita']) {
            expect(byText(label)).toBeTruthy();
        }
        expect(document.body.querySelector('input, textarea')).toBeNull();
    });

    it('"Pamiršau paleisti" pre-fills the untracked gap and sends it to the managers in two taps', async () => {
        await render();
        await click(byText('Pamiršau paleisti laikmatį'));
        const times = [...document.body.querySelectorAll('input[type="time"]')].map((i) => i.value);
        expect(times).toEqual(['09:00', '10:30']);
        await click(byText('Siųsti vadovui'));
        expect(notifyMany).toHaveBeenCalledTimes(1);
        const [recipients, payload] = notifyMany.mock.calls[0];
        expect(recipients).toEqual(['m1']);
        expect(payload).toMatchObject({
            type: 'time_correction_request',
            correctionKind: 'missed_start',
            userId: 'u1',
            // The task the worker went on to — the row right after the gap.
            taskId: 't2',
            requestedStartTime: '2026-09-01T06:00:00.000Z',
            requestedEndTime: '2026-09-01T07:30:00.000Z',
        });
        expect(document.body.textContent).toContain('Prašymas išsiųstas vadovui');
    });

    // Stored rows end mid-minute; the form types whole minutes. The offered gap 09:00–10:30 starts 34 s
    // INSIDE the row that ended 09:00:34 — a rounding artefact that used to be read as an overlap
    // (2026-10-08: Povilas 15:44–16:59, Simona 11:40–12:10) and so lost its one-tap "Taip".
    it('a gap that only grazes its neighbours mid-minute is a normal request, snapped to their edges', async () => {
        const grazing = [
            { ...works[0], endTime: '2026-09-01T06:00:34.664Z' },
            { ...works[1], startTime: '2026-09-01T07:30:07.577Z' },
        ];
        await render({ workRows: grazing });
        await click(byText('Pamiršau paleisti laikmatį'));
        expect(document.body.textContent).not.toContain('persidengia');
        await click(byText('Siųsti vadovui'));
        const [, payload] = notifyMany.mock.calls[0];
        expect(payload).toMatchObject({
            correctionKind: 'missed_start',
            requestedStartTime: '2026-09-01T06:00:34.664Z',
            requestedEndTime: '2026-09-01T07:30:00.000Z',
        });
    });

    // Work done inside a break nobody ended (Kęstutis / Simona 2026-10-12): break time is not payable, so
    // this stays a one-tap request — the flag tells the manager's "Taip" it may shorten the break.
    it('time inside a BREAK is a one-tap request that carries consent to shorten the break', async () => {
        await render({ breakRows: [{ id: 'b1', startTime: '2026-09-01T06:10:00.000Z', endTime: '2026-09-01T07:00:00.000Z' }] });
        await click(byText('Pamiršau paleisti laikmatį'));
        const [start, end] = document.body.querySelectorAll('input[type="time"]');
        await setValue(start, '09:20');
        await setValue(end, '09:50');
        expect(document.body.textContent).toContain('pertrauka');
        expect(byText('Siųsti vadovui').disabled).toBe(false);
        await click(byText('Siųsti vadovui'));
        const [, payload] = notifyMany.mock.calls[0];
        expect(payload).toMatchObject({
            correctionKind: 'missed_start',
            requestedStartTime: '2026-09-01T06:20:00.000Z',
            requestedEndTime: '2026-09-01T06:50:00.000Z',
            absorbBreaks: true,
        });
        expect(payload.commentText).toContain('sutrumpins pertrauką');
    });

    it('time that overlaps a recorded row is not a dead end: it goes to the manager as a plain request', async () => {
        await render();
        await click(byText('Pamiršau paleisti laikmatį'));
        const [start] = document.body.querySelectorAll('input[type="time"]');
        await setValue(start, '08:30');
        expect(document.body.textContent).toContain('persidengia');
        expect(byText('Siųsti vadovui').disabled).toBe(false);
        await click(byText('Siųsti vadovui'));
        const [, payload] = notifyMany.mock.calls[0];
        // Information-only: a one-tap "Taip" would double-credit the overlapped minutes.
        expect(payload).toMatchObject({ correctionKind: 'other' });
        expect(payload.commentText).toContain('persidengia');
    });

    it('"Pamiršau sustabdyti" gives time back on the spot — no request', async () => {
        await render();
        await click(byText('Pamiršau sustabdyti laikmatį'));
        const end = document.body.querySelector('input[type="time"]');
        expect(end.value).toBe('12:00'); // the last row, pre-selected
        await setValue(end, '11:00');
        await click(byText('Pataisyti dabar'));
        expect(reduceOwnWorkSession).toHaveBeenCalledWith(expect.objectContaining({
            session: expect.objectContaining({ id: 'w2' }),
            endTime: '2026-09-01T08:00:00.000Z',
            adminUids: ['a1'],
        }));
        expect(notifyMany).not.toHaveBeenCalled();
    });

    // D11: with the AI switched off, "Kita" must never reach the callable — the worker's words go to
    // the manager as a plain comment, and nothing on the screen promises an AI step.
    it('"Kita" with the AI switched off: no AI call, the comment goes straight to the manager', async () => {
        await render();
        await click(byText('Kita'));
        expect(document.body.textContent).not.toContain('Pabandysime suprasti');
        expect(byText('Toliau')).toBeUndefined();
        await setValue(document.body.querySelector('textarea'), 'ryte pamiršau paspausti');
        await click(byText('Siųsti vadovui'));
        expect(suggestTimeCorrection).not.toHaveBeenCalled();
        expect(notifyMany.mock.calls[0][1]).toMatchObject({ correctionKind: 'other', workerNote: 'ryte pamiršau paspausti', aiSuggested: false });
        expect(document.body.textContent).toContain('Prašymas išsiųstas vadovui');
    });

    it('"Kita" with the AI switched off and no manager: the comment cannot be sent', async () => {
        await render({ managerIds: [] });
        await click(byText('Kita'));
        await setValue(document.body.querySelector('textarea'), 'kažkas negerai');
        expect(byText('Siųsti vadovui').disabled).toBe(true);
        expect(document.body.textContent).toContain('nepriskirtas koordinatorius');
    });

    it('"Kita": the AI proposal is shown for a yes/no, and Taip sends it as a structured request', async () => {
        ai.enabled = true;
        suggestTimeCorrection.mockResolvedValueOnce({ kind: 'missed_start', rowId: '', taskId: 't1', start: '06:30', end: '08:00', summary: 'Pridėti rytą' });
        await render();
        await click(byText('Kita'));
        await setValue(document.body.querySelector('textarea'), 'ryte pamiršau paspausti, dirbau nuo pusės septynių');
        await click(byText('Toliau'));
        expect(suggestTimeCorrection).toHaveBeenCalledWith(expect.objectContaining({ day: DAY, text: expect.stringContaining('pamiršau') }));
        expect(document.body.textContent).toContain('Ar teisingai supratome?');
        await click(byText('Taip, siųsti vadovui'));
        expect(notifyMany.mock.calls[0][1]).toMatchObject({
            correctionKind: 'missed_start', aiSuggested: true, taskId: 't1',
            requestedStartTime: '2026-09-01T03:30:00.000Z', requestedEndTime: '2026-09-01T05:00:00.000Z',
            workerNote: 'ryte pamiršau paspausti, dirbau nuo pusės septynių',
        });
    });

    // "Ne" must send the worker's words ALONE — the proposal already loaded into the form (here an
    // on-the-spot reduction) must never ride along on a refusal.
    it('"Kita": Ne sends only the comment, even when the proposal was a reduction', async () => {
        ai.enabled = true;
        suggestTimeCorrection.mockResolvedValueOnce({ kind: 'missed_stop', rowId: 'w2', taskId: '', start: '10:30', end: '11:00', summary: '' });
        await render();
        await click(byText('Kita'));
        await setValue(document.body.querySelector('textarea'), 'baigiau anksčiau');
        await click(byText('Toliau'));
        await click(byText('Ne, siųsti tik komentarą'));
        expect(reduceOwnWorkSession).not.toHaveBeenCalled();
        expect(notifyMany.mock.calls[0][1]).toMatchObject({ correctionKind: 'other', workerNote: 'baigiau anksčiau', sessionRef: null });
    });

    it('"Kita": when the AI is unreachable, the comment still goes to the manager', async () => {
        ai.enabled = true;
        suggestTimeCorrection.mockRejectedValueOnce(new Error('unavailable'));
        await render();
        await click(byText('Kita'));
        await setValue(document.body.querySelector('textarea'), 'kažkas negerai');
        await click(byText('Toliau'));
        expect(document.body.textContent).toContain('Nepavyko automatiškai suprasti');
        await click(byText('Siųsti komentarą vadovui'));
        expect(notifyMany.mock.calls[0][1]).toMatchObject({ correctionKind: 'other' });
    });

    it('with no manager assigned, a request cannot be sent but a reduction still can', async () => {
        await render({ managerIds: [] });
        await click(byText('Pamiršau paleisti laikmatį'));
        expect(document.body.textContent).toContain('nepriskirtas koordinatorius');
        expect(byText('Siųsti vadovui').disabled).toBe(true);
    });
});
