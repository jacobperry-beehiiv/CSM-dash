import { applyMergeTags } from "../src/lib/templates/merge-tags";
import type { Customer } from "../src/lib/types";

const TEMPLATE = `Hi {{first_name}},
I was reviewing performance across publications on beehiiv and noticed a deliverability signal worth flagging on {{publication_name}}. Your recent send{{#send_name}}, "{{send_name}},"{{/send_name}} showed {{flagged_metric}} of {{flagged_value}}, which is {{above_or_below}} the {{benchmark_value}} we'd typically expect for an audience like yours.
Nothing here is cause for alarm, but deliverability metrics like this one are worth keeping an eye on early — they tend to compound over time and can quietly affect how reliably your emails reach the inbox.

I'd be happy to take a closer look at {{publication_name}} with you and put together a couple of specific, prioritized recommendations. {{cta}}
Either way, you're in good hands — this is exactly the kind of thing we help publishers stay ahead of.
Best,

{{sender_name}}

{{sender_title}}, beehiiv`;

const customer: Partial<Customer> = {
  workspace_id: "test",
  company_name: "Acme Newsletter Co",
  workspace_name: "Acme",
  property_main_contact: "Sarah Chen",
  customer_success_manager: "Jacob_Perry",
  hubspot_contacts: null,
};

console.log("===== WITH send_name set =====\n");
console.log(
  applyMergeTags(TEMPLATE, customer as Customer, {
    deliverability: {
      publication_name: "The Morning Edition",
      send_name: "Q4 Year in Review",
      flagged_metric: "a spam rate",
      flagged_value: "0.42%",
      above_or_below: "above",
      benchmark_value: "0.10%",
      cta: "Reply here and I'll set up 30 min next week.",
    },
  })
);

console.log("\n\n===== WITHOUT send_name (conditional block should drop) =====\n");
console.log(
  applyMergeTags(TEMPLATE, customer as Customer, {
    deliverability: {
      publication_name: "The Morning Edition",
      send_name: null,
      flagged_metric: "an open rate",
      flagged_value: "12%",
      above_or_below: "below",
      benchmark_value: "25%",
      cta: "Let me know if a quick call would help.",
    },
  })
);

console.log("\n\n===== sender_name + sender_title defaults =====\n");
console.log(
  applyMergeTags(
    "Best,\n\n{{sender_name}}\n\n{{sender_title}}, beehiiv",
    customer as Customer,
    {}
  )
);
