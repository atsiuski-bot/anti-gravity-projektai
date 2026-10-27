import { describe, it, expect, vi } from 'vitest';

// D11: while the AI kill switch is off, neither wrapper may even build the callable — a stray
// caller (a stale screen, a future button) gets a refusal, and nothing is sent to the server that
// would forward it to OpenRouter.
vi.mock('../firebase', () => ({ functions: {} }));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn(() => vi.fn()) }));

import { httpsCallable } from 'firebase/functions';
import { AI_CALLABLES_ENABLED, parseTaskText, suggestTimeCorrection } from './aiActions';

describe('aiActions with the AI switched off (D11)', () => {
    it('ships switched off', () => {
        expect(AI_CALLABLES_ENABLED).toBe(false);
    });

    it('parseTaskText refuses without calling the server', async () => {
        await expect(parseTaskText('rytoj Jonui 2 val. tvora', [{ id: 'u1', name: 'Jonas' }])).rejects.toThrow('AI is switched off.');
        expect(httpsCallable).not.toHaveBeenCalled();
    });

    it('suggestTimeCorrection refuses without calling the server', async () => {
        await expect(suggestTimeCorrection({ text: 'pamiršau', day: '2026-10-27', rows: [], tasks: [] })).rejects.toThrow('AI is switched off.');
        expect(httpsCallable).not.toHaveBeenCalled();
    });
});
