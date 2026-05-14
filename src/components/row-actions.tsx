"use client";

import { useState } from "react";
import type { Customer } from "@/lib/types";
import { composeUrlForTemplate, masqueradeUrl } from "@/lib/links";
import { suggestTemplates } from "@/lib/templates/templates";
import { isVisibleToCsm, type StoredTemplate } from "@/lib/templates/types";
import { getTierLadder } from "@/lib/tiers/client";
import { useViewerEmail } from "@/lib/auth-client";

interface Props {
  customer: Customer;
  onDraft: (c: Customer) => void;
}

let templateCachePromise: Promise<StoredTemplate[]> | null = null;
function getTemplates(): Promise<StoredTemplate[]> {
  if (!templateCachePromise) {
    templateCachePromise = fetch("/api/templates").then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<StoredTemplate[]>;
    });
  }
  return templateCachePromise;
}

export function RowActions({ customer, onDraft }: Props) {
  const viewerEmail = useViewerEmail();
  const [emailing, setEmailing] = useState(false);
  const masquerade = masqueradeUrl(customer.owner_email);

  function stop(e: React.MouseEvent) {
    e.stopPropagation();
  }

  async function quickEmail() {
    if (!customer.owner_email) return;
    setEmailing(true);
    try {
      const [allTemplates, ladder] = await Promise.all([
        getTemplates(),
        getTierLadder().catch(() => []),
      ]);
      const templates = allTemplates.filter((t) =>
        isVisibleToCsm(t, viewerEmail)
      );
      const suggestedIds = suggestTemplates(customer);
      const tpl =
        templates.find((t) => suggestedIds.includes(t.id as never)) ??
        templates.find((t) => t.id === "general-checkin") ??
        templates[0];
      if (!tpl) return;
      const url = composeUrlForTemplate(tpl, customer, ladder);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      console.error("Quick email failed:", e);
    } finally {
      setEmailing(false);
    }
  }

  return (
    <div className="flex items-center gap-1 justify-end" onClick={stop}>
      {masquerade ? (
        <a
          href={masquerade}
          target="_blank"
          rel="noopener noreferrer"
          title="Masquerade into workspace"
          aria-label="Masquerade"
          className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas inline-flex items-center"
        >
          <span aria-hidden>👤</span>
        </a>
      ) : null}
      {customer.owner_email ? (
        <button
          onClick={quickEmail}
          disabled={emailing}
          title={`Email ${customer.owner_email}`}
          aria-label="Quick email"
          className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas inline-flex items-center disabled:opacity-50"
        >
          <span aria-hidden>{emailing ? "…" : "✉️"}</span>
        </button>
      ) : null}
      <button
        onClick={() => onDraft(customer)}
        title="Draft outreach (template picker)"
        className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
      >
        Draft
      </button>
    </div>
  );
}
