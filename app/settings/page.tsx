import { effectiveSettings, getOverrides, GROUPS, parseSetting, SETTINGS } from "@/lib/settings";
import { PageHeader } from "../components/ui";
import SettingsForm from "./form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function Settings() {
  const [eff, overrides] = await Promise.all([effectiveSettings(), getOverrides()]);
  // Show saved overrides immediately; "pending" = saved but the worker hasn't reported applying it yet.
  const values = { ...eff.values };
  const pending: string[] = [];
  for (const [k, raw] of Object.entries(overrides)) {
    const r = parseSetting(k, raw);
    if (!("value" in r)) continue;
    if (JSON.stringify(r.value) !== JSON.stringify(eff.values[k])) pending.push(k);
    values[k] = r.value;
  }
  const reportedAgo = eff.at ? Math.round((Date.now() - new Date(eff.at).getTime()) / 1000) : null;

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          <>
            Changes are saved to the database and the worker applies them within ~15 seconds, with no restart or redeploy. They override
            the worker's environment variables; Reset goes back to them. Secrets and RPC URLs are set on the host only.
            {reportedAgo === null ? (
              <span className="text-warn"> The worker hasn't reported its settings yet, so the values shown are this server's defaults.</span>
            ) : reportedAgo > 120 ? (
              <span className="text-warn"> The worker last reported {Math.round(reportedAgo / 60)} min ago: it may be offline.</span>
            ) : null}
          </>
        }
      />
      <SettingsForm
        groups={[...GROUPS]}
        defs={SETTINGS.map((s) => ({ ...s, key: s.key as string }))}
        values={values}
        pending={pending}
        baseline={eff.baseline}
        overridden={Object.keys(overrides)}
      />
    </>
  );
}
