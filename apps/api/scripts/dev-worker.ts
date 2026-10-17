// Local stand-in for Vercel Cron: runs the same tick every 15 seconds.
import { runTick } from "../src/jobs/tick";

const INTERVAL_MS = 15_000;
console.log("Dev worker running (Ctrl+C to stop)");
for (;;) {
  const started = Date.now();
  const report = await runTick({ budgetMs: 12_000 });
  const jobs = report.jobs as { processed?: number } | undefined;
  if (jobs?.processed || report.autoPublish) console.log(new Date().toISOString(), JSON.stringify(report));
  await new Promise((r) => setTimeout(r, Math.max(1000, INTERVAL_MS - (Date.now() - started))));
}
