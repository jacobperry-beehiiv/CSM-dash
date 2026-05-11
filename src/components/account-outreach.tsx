"use client";

import { useState } from "react";
import type { Customer } from "@/lib/types";
import { OutreachModal } from "./outreach-modal";
import { suggestTemplates } from "@/lib/templates/templates";

export function AccountOutreach({ customer }: { customer: Customer }) {
  const [open, setOpen] = useState(false);
  const suggestions = suggestTemplates(customer);

  return (
    <div className="bg-surface rounded-xl border border-border shadow-card p-4">
      <h3 className="font-semibold text-fg mb-2">Outreach</h3>
      <p className="text-sm text-muted">
        Suggested template{suggestions.length === 1 ? "" : "s"}:{" "}
        {suggestions.map((s, i) => (
          <span key={s} className="font-medium text-fg">
            {i > 0 ? ", " : ""}
            {s}
          </span>
        ))}
      </p>
      <button
        onClick={() => setOpen(true)}
        className="mt-3 px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
      >
        Draft outreach
      </button>
      {open && <OutreachModal customer={customer} onClose={() => setOpen(false)} />}
    </div>
  );
}
