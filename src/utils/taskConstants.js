/**
 * Shared task status labels and colors used across TaskCard, TaskTable, and DailyStatistics.
 * Single source of truth to eliminate duplication.
 */

export const STATUS_LABELS = {
    'pending': 'Nepradėtas',
    'in-progress': 'Pradėtas',
    'completed': 'Užbaigtas, nepriduotas',
    'confirmed': 'Užbaigtas, priduotas',
    'unapproved': 'Laukia patvirtinimo',
    'approved': 'Patvirtintas'
};

export const STATUS_COLORS = {
    'pending': 'bg-white text-gray-800 border border-gray-200',
    'in-progress': 'bg-white text-gray-800 border border-gray-200',
    'completed': 'bg-gray-200 text-gray-800',
    'confirmed': 'bg-gray-100 text-gray-800 border-gray-200',
    'unapproved': 'bg-amber-50 text-gray-800 border-amber-200'
};

export const STATUS_STYLES = {
    'pending': 'bg-white border-gray-200',
    'in-progress': 'bg-white border-gray-200',
    'completed': 'bg-gray-200 border-gray-300',
    'confirmed': 'bg-gray-100 border-gray-200',
    'unapproved': 'bg-amber-50 border-amber-200'
};
