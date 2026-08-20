import { auth } from "@/auth";
import { isProfileOptionsAdmin } from "@/lib/auth/admin";
import { loadProfileFieldOptions } from "@/lib/data/profile-field-options";
import { ProfileFieldOptionsEditor } from "@/components/profile-field-options-editor";

export const dynamic = "force-dynamic";

export default async function ProfileFieldsSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  const canEdit = isProfileOptionsAdmin(email);
  const options = await loadProfileFieldOptions();

  return (
    <>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-fg mb-1">
          Prior ESP & Tech Stack options
        </h2>
        <p className="text-xs text-muted">
          These shared lists power the <strong>Prior ESP</strong> and{" "}
          <strong>Tech Stack</strong> pickers on account profiles and the
          matching filters on the CSM &ldquo;All assigned&rdquo; tab.{" "}
          {canEdit
            ? "Add or remove options below — changes apply to everyone."
            : "Only profile-options admins can edit these lists."}
        </p>
      </div>
      <ProfileFieldOptionsEditor initial={options} canEdit={canEdit} />
    </>
  );
}
