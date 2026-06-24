import { Hammer } from 'lucide-react';
import { getSessionColors } from '../utils/sessionColors';
import { cn } from '../utils/cn';

/**
 * SessionTypeIcon — renders the glyph and accent for a session type, both sourced from the
 * single SESSION_COLORS map (DESIGN_SYSTEM §4-B). This is what unifies the "call" color onto
 * blue (it was `sky` here before) and keeps every session icon consistent app-wide.
 */
export default function SessionTypeIcon({ type, className }) {
    const session = getSessionColors(type);

    if (!session) {
        return <Hammer className={cn('text-session-task-accent', className)} aria-hidden="true" />;
    }

    const Icon = session.Icon;
    return <Icon className={cn(session.accent, className)} aria-hidden="true" />;
}
