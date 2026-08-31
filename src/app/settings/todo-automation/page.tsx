import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { TodoSourceConfigsEditor } from "@/components/todo-source-configs-editor";
import { loadTodoSourceConfigsBlob } from "@/lib/data/todo-source-configs";
import { DEFAULT_TODO_SOURCE_CONFIGS } from "@/lib/data/todo-source-configs-types";
import { listTemplates } from "@/lib/templates/store";

export const dynamic = "force-dynamic";

/**
 * /settings/todo-automation — one row per automated TodoSource with:
 *   - editable phrasing template (supports {{company_name}},
 *     {{milestone_days}}, {{prior_stage}}, {{original_text}} merge tags
 *     depending on the source)
 *   - dropdown to link an outreach template. When set, the panel
 *     renders a "Draft outreach" action button on those todos.
 *
 * Admin-gated (super-admin only) since a wrong template binding fires
 * on real customer outreach.
 */
export default async function TodoAutomationSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!isAdmin(email)) {
    notFound();
  }

  const [blob, templates] = await Promise.all([
    loadTodoSourceConfigsBlob(),
    listTemplates(),
  ]);

  // Trim the template list to id + name — that's all the dropdown
  // needs. Keeps the server → client payload small. Sort
  // alphabetically so the picker is scannable; the store returns
  // whatever creation order was on disk, which drifts over time.
  const templateOptions = templates
    .map((t) => ({
      id: t.id,
      name: t.label,
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Todo automation
      </h1>
      <p className="text-sm text-muted mb-4">
        Every automated todo source, with its phrasing template and
        optional linked outreach template. When a source has a linked
        template, todos it fires get a &ldquo;Draft outreach&rdquo;
        button that opens the outreach modal for the associated
        customer with that template pre-selected. Phrasing changes
        take effect on the next fired todo — existing todos keep
        whatever title was baked in at fire time.
      </p>
      <TodoSourceConfigsEditor
        defaults={DEFAULT_TODO_SOURCE_CONFIGS}
        initialOverrides={blob?.by_source ?? {}}
        meta={{
          updated_at: blob?.updated_at ?? null,
          updated_by: blob?.updated_by ?? null,
        }}
        templateOptions={templateOptions}
      />
    </div>
  );
}
