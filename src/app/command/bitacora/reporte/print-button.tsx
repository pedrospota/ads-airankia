"use client";

import { SecondaryButton } from "@/components/ui-kit";

// Tiny client island (design spec §e): the print-view page itself stays a
// server component; only window.print() needs the browser, so it's isolated
// here instead of forcing the whole page client-side. className="cc-no-print"
// hides the button itself under the page's @media print rule.
export default function PrintButton() {
  return (
    <SecondaryButton className="cc-no-print" onClick={() => window.print()}>
      Imprimir / Guardar PDF
    </SecondaryButton>
  );
}
