/**
 * TUI rendering for Openference usage entries and status.
 *
 * Renders a compact one-line status in the footer (via ctx.ui.setStatus) and
 * an expandable usage card in the transcript (via pi.registerEntryRenderer).
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { UsageSnapshot, UsageRecord } from "./usage.ts";

export function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Short footer string: `⚡OF 12 req · $0.42` */
export function footerStatus(snap: UsageSnapshot | null): string {
  if (!snap) return "⚡OF: —";
  const { totals } = snap;
  const parts: string[] = [];
  parts.push(`${totals.billableRequests} req`);
  parts.push(formatUsd(totals.totalCost));
  if (totals.rateLimited > 0) parts.push(`⚠${totals.rateLimited} 429`);
  return `⚡OF ${parts.join(" · ")}`;
}

/** Detailed rate-limit status line, shown when a recent 429/529 happened. */
export function rateLimitLine(snap: UsageSnapshot): string | null {
  const rl = snap.rateLimit;
  if (rl.lastStatus == null) return null;
  const ageMs = rl.updatedAt ? Date.now() - rl.updatedAt : 0;
  if (ageMs > 5 * 60_000) return null; // stale after 5 min
  const secs = Math.round(ageMs / 1000);
  let line = `↳ ${rl.lastStatus} ${secs}s ago`;
  if (rl.wasAbuseThrottle) line += " (abuse throttle";
  else if (rl.lastStatus === 429) line += " (plan/burst limit";
  else if (rl.lastStatus === 529) line += " (overloaded";
  line += ")";
  if (rl.retryAfterSeconds != null) line += ` retry in ${rl.retryAfterSeconds}s`;
  else if (rl.retryAfter) line += ` retry-after ${rl.retryAfter}`;
  if (rl.maxRpm != null) line += ` ≤${rl.maxRpm} rpm`;
  return line;
}

/** Expandable transcript card. */
export function renderUsageCard(snap: UsageSnapshot, expanded: boolean): Box {
  const box = new Box(1, 1, (text) => text);
  const t = snap.totals;

  box.addChild(
    new Text(
      `⚡ Openference usage — ${t.billableRequests} billable req (${snap.windowRequests} in 5h window, ${snap.burstRequests} in 60s burst) · ${formatUsd(t.totalCost)}`,
    ),
  );

  const tokenLine =
    `  tokens: ${formatTokens(t.totalTokens)} total ` +
    `(in ${formatTokens(t.inputTokens)}, out ${formatTokens(t.outputTokens)}, ` +
    `cache read ${formatTokens(t.cacheReadTokens)}, write ${formatTokens(t.cacheWriteTokens)})`;
  box.addChild(new Text(tokenLine));

  const statusLine =
    `  status: ✓${t.success} · 4xx ${t.clientErrors} · 5xx/upstream ${t.upstreamErrors} · 429 ${t.rateLimited} · aborted ${t.aborted}`;
  box.addChild(new Text(statusLine));

  const rl = rateLimitLine(snap);
  if (rl) box.addChild(new Text(rl));

  if (expanded) {
    box.addChild(new Text(""));
    box.addChild(new Text("Per model:"));
    const models = Object.entries(snap.byModel).sort(
      (a, b) => b[1].totalCost - a[1].totalCost,
    );
    for (const [model, m] of models) {
      box.addChild(
        new Text(
          `  ${model}: ${m.billableRequests}/${m.requests} req · ${formatTokens(m.inputTokens + m.outputTokens)} tok · ${formatUsd(m.totalCost)}`,
        ),
      );
    }

    if (snap.recent.length > 0) {
      box.addChild(new Text(""));
      box.addChild(new Text("Recent requests:"));
      for (const r of snap.recent.slice(0, 10)) {
        box.addChild(new Text(`  ${formatRecord(r)}`));
      }
    }
  }

  return box;
}

function formatRecord(r: UsageRecord): string {
  const time = r.timestamp.slice(11, 19);
  const status =
    r.status === "success"
      ? "✓"
      : r.status === "rate_limited"
        ? "⚠429"
        : r.status === "upstream_error"
          ? "✗5xx"
          : r.status === "client_error"
            ? "✗4xx"
            : r.status === "aborted"
              ? "⎋"
              : "?";
  return `${time} ${r.model} [${status}] in ${formatTokens(r.inputTokens)} out ${formatTokens(r.outputTokens)} = ${formatUsd(r.totalCost)}`;
}
