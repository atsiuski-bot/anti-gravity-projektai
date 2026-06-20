/** @type {import('tailwindcss').Config} */
// Design tokens — see docs/design/tokens.md (the source of truth) and DESIGN_SYSTEM.md.
// All keys are collision-safe: they extend, never override, Tailwind defaults — so existing
// markup keeps working while components migrate onto token classes.
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                brand: { DEFAULT: '#4F46E5', hover: '#4338CA', soft: '#EEF2FF', ring: '#818CF8' },
                surface: { base: '#F9FAFB', card: '#FFFFFF', sunken: '#F3F4F6' },
                ink: { strong: '#111827', DEFAULT: '#374151', muted: '#6B7280' },
                line: '#E5E7EB',
                session: {
                    quickWork: { shell: '#EF4444', surface: '#FEF2F2', accent: '#B91C1C' },
                    call: { shell: '#DBEAFE', surface: '#EFF6FF', accent: '#2563EB' },
                    break: { shell: '#FEF3C7', surface: '#FFFBEB', accent: '#B45309' },
                    task: { shell: '#BBF7D0', surface: '#DCFCE7', accent: '#15803D' },
                },
                feedback: {
                    success: '#16A34A',
                    warning: '#F59E0B',
                    danger: '#DC2626',
                    info: '#4F46E5',
                    offline: '#1E293B',
                    scrim: 'rgb(0 0 0 / 0.5)',
                },
            },
            fontSize: {
                caption: ['12px', '16px'],
                body: ['14px', '20px'],
                'body-lg': ['16px', '24px'],
                h3: ['18px', '24px'],
                h2: ['20px', '28px'],
                h1: ['24px', '32px'],
                display: ['30px', '36px'],
            },
            // Semantic radii — deliberately NOT named sm/lg/xl so Tailwind defaults stay intact.
            borderRadius: { input: '6px', control: '8px', card: '12px', modal: '16px' },
            zIndex: { header: '20', nav: '30', backdrop: '40', modal: '50', toast: '60', top: '70' },
            transitionDuration: { fast: '150', base: '200', slow: '300' },
            minHeight: { touch: '44px' },
            minWidth: { touch: '44px' },
        },
    },
    plugins: [],
}
