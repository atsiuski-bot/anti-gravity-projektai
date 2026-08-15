import FilterPills from '../ui/FilterPills';
import SearchBox from '../ui/SearchBox';
import { cn } from '../../utils/cn';

/**
 * PeopleSearchBar — the one filter strip every Komandos veiklos sub-tab mounts above its rows:
 * the immediate assignee pills on the left, the type-ahead search field on the right.
 *
 * It is pure presentation over {@link usePeopleSearchFilter}; the hook owns the state and the
 * narrowing, so a tab wires the two together and nothing else. Pairing them in ONE component is
 * what keeps the sub-tabs from drifting into four slightly different filter bars.
 *
 * Layout follows the app's dual density (DESIGN_SYSTEM §9): on a phone the pills wrap above a
 * full-width search field; from md+ the two share a single row, search right-aligned. `FilterPills`
 * renders nothing when only one person owns rows in this tab, and `md:ml-auto` keeps the field on
 * the right in that case too.
 *
 * @param {{value: string, label: string, userId?: string}[]} people - pills, from the hook.
 * @param {string} filterUser - selected person ('' = all).
 * @param {(v: string) => void} onFilterUser
 * @param {string} searchText
 * @param {(v: string) => void} onSearchText
 * @param {{value: string, kind: string}[]} [suggestions]
 * @param {string} [searchPlaceholder]
 * @param {string} [searchLabel] - accessible name for the search field.
 * @param {string} [peopleLabel] - accessible name for the pill group.
 * @param {string} [className]
 */
export default function PeopleSearchBar({
    people,
    filterUser,
    onFilterUser,
    searchText,
    onSearchText,
    suggestions = [],
    searchPlaceholder = 'Ieškoti…',
    searchLabel = 'Ieškoti',
    peopleLabel = 'Filtruoti pagal meistrą',
    className,
}) {
    return (
        <div className={cn('mb-4 flex flex-col gap-3 md:flex-row md:items-center', className)}>
            <FilterPills
                options={people}
                value={filterUser}
                onChange={onFilterUser}
                allLabel="Visi"
                ariaLabel={peopleLabel}
                className="min-w-0"
            />
            <SearchBox
                value={searchText}
                onChange={onSearchText}
                suggestions={suggestions}
                placeholder={searchPlaceholder}
                ariaLabel={searchLabel}
                className="w-full md:ml-auto md:w-72 md:shrink-0"
            />
        </div>
    );
}
