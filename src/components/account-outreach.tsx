"use client";

import { useState } from "react";
import type { Customer } from "@/lib/types";
import { OutreachModal } from "./outreach-modal";
import { suggestTemplates } from "@/lib/templates/templates";

export function AccountOutreach({ customer }: { customer: Customer }) {
  const [open, setOpen] = useState(false);
  const suggestions = suggestTemplates(customer);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-2">Outreach</h3>
      <p className="text-sm text-gray-600">
        Suggested template{suggestions.length === 1 ? "" : "s"}:{" "}
        {suggestions.map((s, i) => (
          <span key={s} className="font-medium text-gray-900">
            {i > 0 ? ", " : ""}
            {s}
          </span>
        ))}
      </p>
      <button
        onClick={() => setOpen(true)}
        className="mt-3 px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700"
      >
        Draft outreach
      </button>
      {open && <OutreachModal customer={customer} onClose={() => setOpen(false)} />}
    </div>
  );
}
