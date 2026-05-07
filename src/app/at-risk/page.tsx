import { redirect } from "next/navigation";

export default function AtRiskRedirect() {
  redirect("/csm?tab=at-risk");
}
