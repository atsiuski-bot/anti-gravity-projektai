// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The panel's own wiring is under test: which query each role subscribes to (the rules allow a
// coordinator ONLY the ownerId-scoped one), how duties are grouped and ordered, and which write the
// mark button reaches. Firestore and the write layer are stubs; the status model is the real one.
let snapshotDocs = [];
vi.mock('../../firebase', () => ({ db: {}, auth: {}, functions: {} }));
vi.mock('firebase/firestore', () => ({
    collection: vi.fn(() => ({ kind: 'collection' })),
    query: vi.fn(() => ({ kind: 'query' })),
    where: vi.fn(() => ({})),
    orderBy: vi.fn(() => ({})),
    limit: vi.fn(() => ({})),
    getDocs: vi.fn(() => Promise.resolve({ docs: [] })),
    onSnapshot: vi.fn((q, onNext) => {
        onNext({ docs: snapshotDocs.map((d) => ({ id: d.id, data: () => d })) });
        return () => {};
    }),
}));
vi.mock('../../utils/errorLog', () => ({ logError: vi.fn() }));
vi.mock('../../utils/dutyActions', () => ({
    createDuty: vi.fn(() => Promise.resolve()),
    updateDuty: vi.fn(() => Promise.resolve()),
    archiveDuty: vi.fn(() => Promise.resolve()),
    markDuty: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../utils/timeUtils', async (importOriginal) => ({
    ...(await importOriginal()),
    getLithuanianDateString: () => '2026-10-16',
}));

let authValue = {};
vi.mock('../../context/AuthContext', () => ({ useAuth: () => authValue }));
const usersMap = {
    a1: { id: 'a1', role: 'admin', displayName: 'Audrius Admin' },
    c1: { id: 'c1', role: 'manager', displayName: 'Živilė Koordinatorė' },
    c2: { id: 'c2', role: 'manager', displayName: 'Aldona Bendra' },
};
vi.mock('../../context/UsersContext', () => ({
    useUsers: () => ({ usersMap, activeUsers: Object.values(usersMap) }),
}));
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const { default: DutiesPanel } = await import('./DutiesPanel');
const firestore = await import('firebase/firestore');
const { markDuty } = await import('../../utils/dutyActions');

const byText = (text) => [...document.body.querySelectorAll('button')].filter((b) => b.textContent.trim() === text);
const click = async (el) => { await act(async () => { el.click(); }); };

describe('DutiesPanel', () => {
    let container;
    let root;

    const render = async () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => { root.render(<DutiesPanel />); });
    };

    beforeEach(() => {
        global.IS_REACT_ACT_ENVIRONMENT = true;
        window.matchMedia = window.matchMedia || (() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
        vi.clearAllMocks();
        snapshotDocs = [
            { id: 'd-ok', title: 'Išsiųsti atsiliepimai', ownerId: 'c1', intervalDays: 7, coveredThrough: '2026-10-15', lastNote: 'Visi išsiųsti' },
            { id: 'd-late', title: 'Sąskaitos', ownerId: 'c1', intervalDays: 7, coveredThrough: '2026-10-01' },
            { id: 'd-old', title: 'Senas', ownerId: 'c1', intervalDays: 7, archived: true },
            { id: 'd-admin', title: 'Admino pareiga', ownerId: 'a1', intervalDays: 14, coveredThrough: null },
            { id: 'd-c2', title: 'Kitos koordinatorės', ownerId: 'c2', intervalDays: 30, coveredThrough: '2026-10-10' },
        ];
    });
    afterEach(() => {
        act(() => root?.unmount());
        container?.remove();
        document.body.innerHTML = '';
    });

    it('a coordinator subscribes only to their own duties and sees late first, archived hidden', async () => {
        authValue = { currentUser: { uid: 'c1' }, userRole: 'manager' };
        snapshotDocs = snapshotDocs.filter((d) => d.ownerId === 'c1');
        await render();

        expect(firestore.where).toHaveBeenCalledWith('ownerId', '==', 'c1');
        const titles = [...document.querySelectorAll('h3')].map((h) => h.textContent);
        expect(titles).toEqual(['Sąskaitos', 'Išsiųsti atsiliepimai']);
        const text = document.body.textContent;
        expect(text).toContain('Vėluoja 8 d.');
        expect(text).toContain('Suvesta iki spalio 15 d. imtinai');
        expect(text).toContain('kitas kartas iki spalio 22 d.');
        expect(text).toContain('„Visi išsiųsti“');
        expect(text).not.toContain('Senas');
        expect(document.querySelectorAll('h2')).toHaveLength(0); // no per-person grouping
    });

    it('an admin subscribes to every duty and sees them grouped by person, own first', async () => {
        authValue = { currentUser: { uid: 'a1' }, userRole: 'admin' };
        await render();

        expect(firestore.where).not.toHaveBeenCalled();
        const groups = [...document.querySelectorAll('h2')].map((h) => h.textContent);
        expect(groups).toEqual(['Audrius A.', 'Aldona B.', 'Živilė K.']);
        expect(document.body.textContent).toContain('Dar nepažymėta');
    });

    it('marking a duty writes "covered through today" by default, signed by the actor', async () => {
        authValue = { currentUser: { uid: 'c1' }, userRole: 'manager' };
        snapshotDocs = snapshotDocs.filter((d) => d.id === 'd-ok');
        await render();

        await click(byText('Pažymėti')[0]);
        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog.textContent).toContain('Ankstesnė žyma: iki spalio 15 d.');
        const buttons = byText('Pažymėti');
        await click(buttons[buttons.length - 1]); // the dialog's own submit

        expect(markDuty).toHaveBeenCalledWith('d-ok', { coveredThrough: '2026-10-16', note: '' }, 'c1');
    });
});
