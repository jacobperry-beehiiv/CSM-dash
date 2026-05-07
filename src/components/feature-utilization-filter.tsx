"use client";

import { useEffect, useMemo, useState } from "react";
import type { Customer } from "@/lib/types";
import { customerFeatures, type FeatureStatus } from "@/lib/features";

interface Props {
  customers: Customer[];
  /** Called whenever the filter changes. `null` clears the filter. */
  onFilterChange: (predicate: ((c: Customer) => boolean) | null) => void;
}

type Combine = "any" | "all";

/**
 * Multi-select feature-utilization filter. Pick any number of features to
 * filter accounts by; "match any" shows accounts not using AT LEAST ONE
 * picked feature, "match all" shows accounts not using ALL picked features.
 *
 * Sits above the customer table in the consolidated book view; collapsed
 * by default to keep the table front-and-center.
 */
export function FeatureUtilizationFilter({ customers, onFilterChange }: Props) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [combine, setCombine] = useState<Combine>("any");

  // Build the feature catalog once from the first customer (every customer
  // has the same feature catalog — the values differ, the keys don't).
  const catalog = useMemo<FeatureStatus[]>(() => {
    if (customers.length === 0) return [];
    return customerFeatures(customers[0]);
  }, [customers]);

  const grouped = useMemo(() => {
    const map = new Map<FeatureStatus["group"], FeatureStatus[]>();
    for (const f of catalog) {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    }
    return Array.from(map.entries());
  }, [catalog]);

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clear() {
    setPicked(new Set());
  }

  // Emit predicate whenever inputs change
  useEffect(() => {
    if (picked.size === 0) {
      onFilterChange(null);
      return;
    }
    onFilterChange((c: Customer) => {
      const states = customerFeatures(c).reduce(
        (acc, f) => {
          acc[f.key] = f.state;
          return acc;
        },
        {} as Record<string, FeatureStatus["state"]>
      );
      const isInactive = (k: string) => {
        const s = states[k];
        return s === "inactive" || s === "unknown";
      };
      if (combine === "any") {
        // Customer is "underutilizing any of the picked features"
        for (const k of picked) if (isInactive(k)) return true;
        return false;
      }
      // combine === "all": every picked feature is unused
      for (const k of picked) if (!isInactive(k)) return false;
      return true;
    });
  }, [picked, combine, onFilterChange]);

  const counts = useMemo(() => {
    if (picked.size === 0) return null;
    let inAny = 0;
    let inAll = 0;
    for (const c of customers) {
      const states = customerFeatures(c).reduce(
        (acc, f) => {
          acc[f.key] = f.state;
          return acc;
        },
        {} as Record<string, FeatureStatus["state"]>
      );
      const inactiveKeys = [...picked].filter((k) => {
        const s = states[k];
        return s === "inactive" || s === "unknown";
      });
      if (inactiveKeys.length > 0) inAny++;
      if (inactiveKeys.length === picked.size) inAll++;
    }
    return { inAny, inAll };
  }, [picked, customers]);

  return (
    <div className="rounded-md border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="text-sm font-medium text-gray-900">
          Feature utilization filter
          {picked.size > 0 ? (
            <span className="ml-2 text-xs text-gray-500 font-normal">
              ({picked.size} selected · {combine})
            </span>
          ) : null}
        </span>
        <span
          className={`text-gray-400 transition-transform ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ▸
        </span>
      </button>

      {open ? (
        <div className="px-3 py-3 border-t border-gray-200 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-600">Show customers</span>
            <span className="font-medium">not using</span>
            <select
              value={combine}
              onChange={(e) => setCombine(e.target.value as Combine)}
              className="px-2 py-0.5 border border-gray-300 rounded-md bg-white"
            >
              <option value="any">any of</option>
              <option value="all">all of</option>
            </select>
            <span className="text-gray-600">the selected features.</span>
            {counts ? (
              <span className="ml-auto text-gray-500">
                <strong>{combine === "any" ? counts.inAny : counts.inAll}</strong>
                /{customers.length} match
              </span>
            ) : null}
          </div>

          {grouped.map(([group, items]) => (
            <fieldset
              key={group}
              className="border border-gray-200 rounded-md p-2"
            >
              <legend className="text-xs text-gray-500 px-1">{group}</legend>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                {items.map((f) => {
                  const checked = picked.has(f.key);
                  return (
                    <label
                      key={f.key}
                      className={`flex items-start gap-2 px-2 py-1 rounded cursor-pointer text-sm hover:bg-gray-50 ${
                        checked ? "bg-blue-50/50" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(f.key)}
                        className="mt-1 h-4 w-4 rounded border-gray-300 cursor-pointer flex-shrink-0"
                      />
                      <span className="text-gray-800 break-words">
                        {f.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}

          {picked.size > 0 ? (
            <div className="flex">
              <button
                onClick={clear}
                className="text-xs text-blue-600 hover:underline"
              >
                Clear feature filter
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
