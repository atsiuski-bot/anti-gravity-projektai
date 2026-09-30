// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../context/UsersContext', () => ({
    useUsers: () => ({
        usersMap: {
            m1: { displayName: 'Simona Vadovė' },
            m2: { displayName: 'Povilas Vadovas' },
        },
    }),
}));
vi.mock('../../context/ProfileViewerContext', () => ({ useProfileViewer: () => ({ openProfile: vi.fn() }) }));

const { default: AcceptedByChip } = await import('./AcceptedByChip');

let root;
let host;
const render = async (task) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<AcceptedByChip task={task} />); });
    return host.textContent;
};

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('AcceptedByChip', () => {
    it('names the manager who accepted the finished work', async () => {
        const text = await render({ status: 'confirmed', confirmedBy: 'm2', confirmedAt: '2026-09-29T17:10:00.000Z' });
        expect(text).toContain('Priėmė');
        expect(text).toContain('Povilas');
        expect(text).not.toContain('Simona');
    });

    it('shows nothing while the work still awaits acceptance', async () => {
        expect(await render({ status: 'completed', confirmedBy: 'm1' })).toBe('');
    });

    it('shows nothing for a creation approval (approvedBy is a different gate)', async () => {
        expect(await render({ status: 'approved', approvedBy: 'm1' })).toBe('');
    });

    it('shows nothing when the acceptor is unknown (legacy row)', async () => {
        expect(await render({ status: 'confirmed', confirmedBy: 'ghost' })).toBe('');
    });

    it('shows nothing when no acceptor was recorded', async () => {
        expect(await render({ status: 'confirmed' })).toBe('');
    });
});
