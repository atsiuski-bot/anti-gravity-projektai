import { cn } from '../../utils/cn';
import FilterPills from './FilterPills';
import SearchBox from './SearchBox';

/**
 * ListFilterBar — the canonical "who + what" narrowing strip: a row of person pills over a
 * type-ahead search field.
 *
 * It is the visible half of `useListSearchFilter`, so every manager sub-tab that is not the
 * canonical team list (Laukia patvirtinimo, Pridavimas, Istorija, Pasikartojančios užduotys)
 * offers the SAME two controls in the same place, and a manager learns them once. The pill row is
 * the immediate single-select by person (identical to the one above the team list — same
 * `FilterPills`, same `UserChip` rendering); the search field is the identical `SearchBox`
 * combobox, so diacritic-insensitive, typo-tolerant, ranked matching behaves the same everywhere.
 *
 * Rendered inline on every viewport, unlike the team list — which collapses its search behind an
 * icon on desktop only because that list's toolbar also carries the sort launcher and board
 * toggle. These tabs have no such competition for width, so the field stays visible.
 *
 * Renders nothing when there is nothing to narrow (no people AND no rows), so an empty tab is not
 * fronted by dead controls.
 *
 * @param {{value: string, label: string, userId?: string}[]} assigneeOptions - people present in the list.
 * @param {string} filterUser - selected person uid ('' = everyone).
 * @param {(v: string) => void} onFilterUserChange
 * @param {string} searchText
 * @param {(v: string) => void} onSearchChange
 * @param {{value: string, kind: string}[]} [searchSuggestions]
 * @param {boolean} [showSearch=true] - hide the field when the list is too small to search.
 * @param {string} [searchPlaceholder]
 * @param {string} [searchLabel] - accessible name for the field (there is no visible label).
 * @param {string} [assigneeLabel] - accessible name for the pill group.
 * @param {string} [className]
 */
export default function ListFilterBar({
    assigneeOptions = [],
    filterUser,
    onFilterUserChange,
    searchText,
    onSearchChange,
    searchSuggestions = [],
    showSearch = true,
    searchPlaceholder = 'Ieškoti užduočių…',
    searchLabel = 'Ieškoti užduočių',
    assigneeLabel = 'Filtruoti pagal meistrą',
    className,
}) {
    if (assigneeOptions.length === 0 && !showSearch) return null;

    return (
        <div className={cn('mb-4 space-y-3', className)}>
            {/* Centered like the team list's pill row, so a short roster sits in the middle of the
                content column instead of being stranded at the left edge. */}
            <FilterPills
                options={assigneeOptions}
                value={filterUser}
                onChange={onFilterUserChange}
                allLabel="Visi"
                ariaLabel={assigneeLabel}
                className="justify-center"
            />
            {showSearch && (
                <SearchBox
                    value={searchText}
                    onChange={onSearchChange}
                    suggestions={searchSuggestions}
                    placeholder={searchPlaceholder}
                    ariaLabel={searchLabel}
                    className="w-full md:max-w-md"
                />
            )}
        </div>
    );
}
