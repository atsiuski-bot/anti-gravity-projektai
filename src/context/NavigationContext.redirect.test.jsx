// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The provider reads auth through this module; mocking it keeps the real Firebase SDK (and its
// network + IndexedDB boot) out of the test, which is the only reason a React render is feasible
// here at all.
let authValue = { currentUser: null, userRole: null };
vi.mock('./AuthContext', () => ({
    useAuth: () => authValue,
}));

const { NavigationProvider } = await import('./NavigationContext');

// A stand-in for App.jsx's ProtectedRoute. It is deliberately reduced to the ONE behaviour under
// test — "no signed-in user on the app route means redirect to /login" — because importing App.jsx
// would drag in the whole Firebase-backed provider stack. If App's redirect target or mechanism
// ever changes, mirror it here.
const ProtectedRoute = ({ children }) =>
    (authValue.currentUser ? children : <Navigate to="/login" />);

let seenLocation = null;
const LocationProbe = () => {
    seenLocation = useLocation();
    return null;
};

const renderApp = (container) => {
    const root = createRoot(container);
    act(() => {
        root.render(
            <MemoryRouter initialEntries={['/']}>
                <NavigationProvider>
                    <LocationProbe />
                    <Routes>
                        <Route path="/login" element={<div data-testid="login">login</div>} />
                        <Route path="/" element={<ProtectedRoute><div data-testid="app">app</div></ProtectedRoute>} />
                    </Routes>
                </NavigationProvider>
            </MemoryRouter>
        );
    });
    return root;
};

describe('NavigationProvider tab mirror vs. the signed-out redirect', () => {
    let container;
    let root;

    beforeEach(() => {
        global.IS_REACT_ACT_ENVIRONMENT = true;
        seenLocation = null;
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => root?.unmount());
        container.remove();
        root = null;
    });

    // The white-screen regression: the provider sits above the router outlet, so its ?tab= mirror
    // effect runs AFTER <Navigate>'s. Before the currentUser guard, that mirror replaced the
    // just-pushed /login entry with /?tab=tasks — and because <Navigate> only fires once per mount,
    // nothing retried. The app rendered null on the protected route forever: a blank page that
    // never reached the login screen.
    it('lets a signed-out visitor reach /login instead of parking on a blank app route', () => {
        authValue = { currentUser: null, userRole: null };
        root = renderApp(container);

        expect(seenLocation.pathname).toBe('/login');
        expect(container.querySelector('[data-testid="login"]')).not.toBeNull();
    });

    // The other half of the contract: the mirror must still run for a real session, or a reload
    // would lose the open tab. Without this, deleting the effect would also make the test above pass.
    it('still mirrors the active tab into ?tab= for a signed-in user', () => {
        authValue = { currentUser: { uid: 'u1' }, userRole: 'worker' };
        root = renderApp(container);

        expect(seenLocation.pathname).toBe('/');
        expect(new URLSearchParams(seenLocation.search).get('tab')).toBe('tasks');
        expect(container.querySelector('[data-testid="app"]')).not.toBeNull();
    });
});
