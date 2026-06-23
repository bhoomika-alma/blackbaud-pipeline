// Phase B — row cleaning / derivation. Pure functions, no I/O, fully unit-tested.

export type PipelineKey = "highered" | "k12" | "canada" | "england";

/**
 * The four Blackbaud pipelines, by stable key, display name, and HubSpot
 * `region` enum code. The HubSpot deal `region` property is an enumeration that
 * only accepts BBUS / BBC / BBE (US, Canada, England) — both US pipelines map to BBUS.
 */
export const BB_PIPELINES: Record<
  PipelineKey,
  { key: PipelineKey; name: string; regionCode: string }
> = {
  highered: { key: "highered", name: "Blackbaud HigherEd pipeline", regionCode: "BBUS" },
  k12: { key: "k12", name: "Blackbaud k12 pipeline", regionCode: "BBUS" },
  canada: { key: "canada", name: "Blackbaud Canada", regionCode: "BBC" },
  england: { key: "england", name: "Blackbaud England", regionCode: "BBE" },
};

/** Stages that count as "active" — drive the demonstrate-stage date and Phase C. */
export const ACTIVE_STAGES = ["demonstrate", "propose", "negotiate"];

/** Two-part ccTLD suffixes that should NOT have their leading label stripped. */
const CCTLD_2PART = [".ac.uk", ".co.uk", ".org.uk", ".ab.ca"];

export interface CleanedDomain {
  domain: string;
  flagged: boolean;
}

/**
 * Website → domain. Lowercase/trim; strip protocol, `www.`, path, and port.
 * If the host has 3+ labels and isn't a known 2-part ccTLD, strip the leading
 * sub-label and flag it for review.
 * e.g. `https://www.uwindsor.ca/` → { domain: "uwindsor.ca", flagged: false }
 */
export function cleanDomain(website: string | null | undefined): CleanedDomain {
  let host = (website ?? "").trim().toLowerCase();
  if (!host) return { domain: "", flagged: false };

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip protocol
  host = host.replace(/^\/\//, ""); // strip protocol-relative leading slashes
  host = host.replace(/^www\./, ""); // strip leading www.
  host = host.split(/[/?#]/)[0]; // cut path / query / fragment
  host = host.replace(/:\d+$/, ""); // strip port (e.g. :443)
  host = host.replace(/\.+$/, ""); // strip trailing dot(s)

  if (!host) return { domain: "", flagged: false };

  const labels = host.split(".");
  const isTwoPartCctld = CCTLD_2PART.some((suffix) => host.endsWith(suffix));

  if (labels.length >= 3 && !isTwoPartCctld) {
    return { domain: labels.slice(1).join("."), flagged: true };
  }
  return { domain: host, flagged: false };
}

export interface SplitNameResult {
  firstName: string;
  lastName: string;
}

/** Contact Name → first/last. First token = first name; the remainder = last name. */
export function splitName(contactName: string | null | undefined): SplitNameResult {
  const cleaned = (contactName ?? "").trim().replace(/\s+/g, " ");
  if (!cleaned) return { firstName: "", lastName: "" };
  const idx = cleaned.indexOf(" ");
  if (idx === -1) return { firstName: cleaned, lastName: "" };
  return { firstName: cleaned.slice(0, idx), lastName: cleaned.slice(idx + 1) };
}

/**
 * Demonstrate Stage Date: equals the Last Stage Change Date when the stage is
 * Demonstrate / Propose / Negotiate; otherwise blank (null).
 */
export function demonstrateStageDate(
  stage: string | null | undefined,
  lastStageChangeDate: string | null | undefined,
): string | null {
  const s = (stage ?? "").trim().toLowerCase();
  if (!ACTIVE_STAGES.includes(s)) return null;
  const date = (lastStageChangeDate ?? "").trim();
  return date.length > 0 ? date : null;
}

function normalizeVertical(vertical: string | null | undefined): string {
  return (vertical ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Derive the pipeline NAME from region + vertical:
 *   England → "Blackbaud England"; Canada → "Blackbaud Canada";
 *   US / LatAm (and any other region) → K12 → "Blackbaud k12 pipeline",
 *   else → "Blackbaud HigherEd pipeline".
 */
export function derivePipeline(
  region: string | null | undefined,
  vertical: string | null | undefined,
): string {
  const r = (region ?? "").trim().toLowerCase();
  if (r === "england") return BB_PIPELINES.england.name;
  if (r === "canada") return BB_PIPELINES.canada.name;
  return normalizeVertical(vertical) === "k12" ? BB_PIPELINES.k12.name : BB_PIPELINES.highered.name;
}

/** Reverse-lookup the pipeline key for a derived pipeline name. */
export function pipelineKeyForName(name: string): PipelineKey | undefined {
  return Object.values(BB_PIPELINES).find((p) => p.name === name)?.key;
}

/** Deal Name = Account Name + " - " + derived pipeline name. */
export function buildDealName(
  accountName: string | null | undefined,
  pipelineName: string,
): string {
  return `${(accountName ?? "").trim()} - ${pipelineName}`;
}
