import { redirect } from "next/navigation";

export default function DeliverabilityRedirect() {
  redirect("/csm?tab=deliverability");
}
