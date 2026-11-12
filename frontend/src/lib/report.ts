import { findSharedDependencies, outcomeFor } from './graph';
import { compareOptions, describeChange, PRIORITIES, showValue } from './mitigation';
import { assumptionTargetLabel } from './scenarioOps';
import { CONFIDENCE_LABEL, CRIT_LABEL, KIND_LABEL, LINK_STATUSES, RELATION_LABEL, STATUS_LABEL, type Scenario } from './types';

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'table'; head: string[]; rows: string[][] };

export interface ReportOptions {
  inventory: boolean;
  dependencies: boolean;
  assumptions: boolean;
  shared: boolean;
  /** Include the cascade for this saved run. */
  runId: string | null;
  mitigation: boolean;
}

export const DISCLAIMER =
  'GhostGrid is a prototype decision-support tool, not a certified safety system. Results reflect only the dependencies that were mapped and a simplified failure model.';

export const SIMULATED_NOTICE = 'This scenario is simulated sample data. It was invented for demonstration and does not describe real infrastructure.';

export function buildReport(s: Scenario, o: ReportOptions, generatedAt = new Date()): Block[] {
  const name = (id: string) => s.assets.find((x) => x.id === id)?.name ?? 'Unknown asset';
  const blocks: Block[] = [
    { t: 'h', level: 1, text: `${s.name}: resilience report` },
    { t: 'p', text: `Generated ${generatedAt.toLocaleString()} · Sector: ${s.sector}` },
  ];
  if (s.isSample) blocks.push({ t: 'p', text: SIMULATED_NOTICE });
  blocks.push({ t: 'p', text: DISCLAIMER });
  if (s.description) blocks.push({ t: 'p', text: s.description });

  const byStatus = LINK_STATUSES.map((st) => `${s.dependencies.filter((d) => d.status === st).length} ${STATUS_LABEL[st].toLowerCase()}`);
  blocks.push({
    t: 'ul',
    items: [
      `${s.assets.length} assets`,
      `${s.dependencies.length} mapped dependencies (${byStatus.join(', ')}; ${s.dependencies.filter((d) => d.mode === 'alternate').length} alternate)`,
      `${s.assumptions.length} recorded assumptions`,
    ],
  });

  if (o.inventory) {
    blocks.push({ t: 'h', level: 2, text: 'Asset inventory' });
    blocks.push(
      s.assets.length
        ? {
            t: 'table',
            head: ['Asset', 'Kind', 'Criticality', 'Notes'],
            rows: s.assets.map((x) => [x.name, KIND_LABEL[x.kind], CRIT_LABEL[x.criticality], x.notes || '-']),
          }
        : { t: 'p', text: 'No assets have been mapped.' },
    );
  }

  if (o.dependencies) {
    blocks.push({ t: 'h', level: 2, text: 'Mapped dependencies' });
    blocks.push(
      s.dependencies.length
        ? {
            t: 'table',
            head: ['Dependent asset', 'Relies on', 'Relationship', 'Status', 'Type', 'Notes'],
            rows: s.dependencies.map((d) => [
              name(d.dependentId),
              name(d.providerId),
              RELATION_LABEL[d.relation],
              STATUS_LABEL[d.status],
              d.mode === 'required' ? 'Required' : 'Alternate',
              d.notes || '-',
            ]),
          }
        : { t: 'p', text: 'No dependencies have been mapped.' },
    );
    const weak = s.dependencies.filter((d) => d.status !== 'confirmed').length;
    if (weak)
      blocks.push({
        t: 'p',
        text: `${weak} of ${s.dependencies.length} dependencies are inferred or unknown. Failure analysis treats them as live, so findings that rely on them need verification.`,
      });
  }

  if (o.assumptions) {
    blocks.push({ t: 'h', level: 2, text: 'Assumptions' });
    blocks.push(
      s.assumptions.length
        ? {
            t: 'table',
            head: ['Assumption', 'About', 'Confidence'],
            rows: s.assumptions.map((a) => [a.text, assumptionTargetLabel(s, a), CONFIDENCE_LABEL[a.confidence]]),
          }
        : { t: 'p', text: 'No assumptions have been recorded.' },
    );
  }

  if (o.shared) {
    const shared = findSharedDependencies(s.assets, s.dependencies);
    blocks.push({ t: 'h', level: 2, text: 'Hidden shared dependencies' });
    blocks.push({
      t: 'p',
      text: 'An asset is listed when its failure reaches other assets that do not list it as a direct dependency.',
    });
    blocks.push(
      shared.length
        ? {
            t: 'table',
            head: ['Asset', 'Direct failures', 'Hidden failures', 'Critical assets reached'],
            rows: shared.map((x) => [
              x.asset.name,
              String(x.direct.length),
              String(x.hidden.length),
              x.criticalReached.length ? x.criticalReached.map(name).join(', ') : '-',
            ]),
          }
        : { t: 'p', text: 'No hidden shared dependencies were found in the mapped graph.' },
    );
  }

  const run = o.runId ? s.runs.find((r) => r.id === o.runId) : undefined;
  if (run) {
    const seed = { nodes: run.failedIds, links: run.failedLinkIds };
    const out = outcomeFor(s.assets, s.dependencies, seed);
    const linkName = (id: string) => {
      const d = s.dependencies.find((x) => x.id === id);
      return d ? `${name(d.dependentId)} → ${name(d.providerId)}` : 'Unknown dependency';
    };
    const failedWhat = [...run.failedIds.map(name), ...run.failedLinkIds.map((id) => `dependency ${linkName(id)}`)].join(', ');
    blocks.push({ t: 'h', level: 2, text: `Failure run: ${run.name}` });
    blocks.push({
      t: 'p',
      text: `Initial failures: ${failedWhat}. ${out.total} assets fail in total (${out.cascaded} through cascade), including ${out.critical} critical. Inferred and unknown links are treated as live.`,
    });
    blocks.push({
      t: 'table',
      head: ['Round', 'Assets that fail'],
      rows: out.sim.rounds.map((r, i) => [i === 0 ? 'Initial' : String(i), r.length ? r.map(name).join(', ') : '(links only)']),
    });

    if (o.mitigation) {
      blocks.push({ t: 'h', level: 2, text: 'Mitigation comparison' });
      if (!s.strategies.length) blocks.push({ t: 'p', text: 'No mitigation strategies have been defined.' });
      else {
        const cmp = compareOptions(s.assets, s.dependencies, seed, s.strategies, 'impact');
        const { baseline } = cmp;
        blocks.push({
          t: 'p',
          text: `Ranking: ${PRIORITIES.impact.label}. ${PRIORITIES.impact.description} Cost and effort are the author's own estimates, not computed by GhostGrid.`,
        });
        blocks.push({
          t: 'table',
          head: ['Strategy', 'Assets failed', 'Critical failed', 'Avoided vs baseline', 'Effort (estimate)', 'Cost (estimate)'],
          rows: [
            ['Baseline (no change)', String(baseline.total), String(baseline.critical), '-', '-', '-'],
            ...cmp.results.map((r) => [
              r.valid ? `${r.rank}. ${r.option.name}` : `${r.option.name} (dependency removed)`,
              String(r.outcome.total),
              String(r.outcome.critical),
              String(baseline.total - r.outcome.total),
              showValue(r, 'effort'),
              showValue(r, 'cost'),
            ]),
          ],
        });
        blocks.push({
          t: 'ul',
          items: cmp.results.filter((r) => r.valid).map((r) => `${r.option.name}: ${r.changes.map((c) => describeChange(c, name)).join('; ')}.`),
        });
      }
    }
  } else if (o.mitigation) {
    blocks.push({ t: 'h', level: 2, text: 'Mitigation comparison' });
    blocks.push({ t: 'p', text: 'Choose a saved failure run to compare mitigation strategies against.' });
  }

  return blocks;
}

export function reportToMarkdown(blocks: Block[]): string {
  const esc = (v: string) => v.replace(/\|/g, '\\|');
  return (
    blocks
      .map((b) => {
        switch (b.t) {
          case 'h':
            return `${'#'.repeat(b.level)} ${b.text}`;
          case 'p':
            return b.text;
          case 'ul':
            return b.items.map((i) => `- ${i}`).join('\n');
          case 'table':
            return [
              `| ${b.head.map(esc).join(' | ')} |`,
              `| ${b.head.map(() => '---').join(' | ')} |`,
              ...b.rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
            ].join('\n');
        }
      })
      .join('\n\n') + '\n'
  );
}
