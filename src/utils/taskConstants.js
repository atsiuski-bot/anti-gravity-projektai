/**
 * Shared task status labels and colors used across TaskCard, TaskTable, and DailyStatistics.
 * Single source of truth to eliminate duplication.
 */

// Single source of truth for status copy. `completed`/`confirmed` carry the manager-
// confirmation vocabulary (Nepatvirtinta / Patvirtinta) so every surface — worker card,
// manager table, daily statistics, reports — uses the same word for the same state, and the
// on-screen label always matches the export label.
export const STATUS_LABELS = {
    'pending': 'Nepradėtas',
    'in-progress': 'Pradėtas',
    'completed': 'Nepatvirtinta',
    'confirmed': 'Patvirtinta',
    'unapproved': 'Laukia patvirtinimo',
    'approved': 'Patvirtintas'
};

export const STATUS_STYLES = {
    'pending': 'bg-surface-card border-line',
    'in-progress': 'bg-surface-card border-line',
    'completed': 'bg-surface-sunken border-line',
    'confirmed': 'bg-surface-sunken border-line',
    'unapproved': 'bg-feedback-warning-soft border-feedback-warning-border'
};
