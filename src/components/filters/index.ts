/**
 * Shared filter primitives — every page's filter strip composes these so
 * the visuals (height, padding, focus ring, hover state) stay consistent.
 *
 *   <FilterBar>
 *     <SearchInput value={…} onChange={…} />
 *     <CsmSelector csms={…} />
 *     <SelectFilter label="Cadence" value={…} onChange={…} options={…} />
 *     <SegmentToggle options={…} value={…} onChange={…} />
 *   </FilterBar>
 *
 *   <ChipMultiSelect options={…} selected={…} onToggle={…} countMap={…} />
 *
 *   <FilterPanel title="Ad-network filters">
 *     …complex form…
 *   </FilterPanel>
 */
export { FilterBar } from "./filter-bar";
export { SearchInput } from "./search-input";
export { SelectFilter, type SelectOption } from "./select-filter";
export { SegmentToggle, type SegmentOption } from "./segment-toggle";
export { ChipMultiSelect, type ChipOption } from "./chip-multi-select";
export {
  MultiSelectFilter,
  type MultiSelectOption,
} from "./multi-select-filter";
export { FilterPanel } from "./filter-panel";
