/**
 * STATUS_GLYPHS — canonical map of a task's status key (from deriveTaskStatus) to its custom
 * glyph component (ADR 0010 §"Status circle"). Kept in its own constants module — mirroring the
 * sessionColors.js / badgeCatalog.js pattern — so the glyph file stays components-only (React
 * Fast Refresh) and there is exactly one place that pairs a state with its shape.
 */
import {
    StatusPendingGlyph,
    StatusRunningGlyph,
    StatusPausedGlyph,
    StatusCompletedGlyph,
    StatusConfirmedGlyph,
    StatusAwaitingGlyph,
    StatusApprovedGlyph,
} from './statusGlyphs';

export const STATUS_GLYPHS = {
    pending: StatusPendingGlyph,
    running: StatusRunningGlyph,
    paused: StatusPausedGlyph,
    completed: StatusCompletedGlyph,
    confirmed: StatusConfirmedGlyph,
    unapproved: StatusAwaitingGlyph,
    approved: StatusApprovedGlyph,
};
