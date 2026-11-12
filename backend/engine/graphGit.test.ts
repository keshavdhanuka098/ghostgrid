import { describe, expect, it } from 'vitest';
import { branchTree, commitLabel, sameGraphContent, summaryText, type BranchInfo, type ChangeSummary } from './graphGit';
import { asset, dep } from './testkit';

const branch = (id: string, parent: string | null, over: Partial<BranchInfo> = {}): BranchInfo =>
  ({ id, name: id, parentBranchId: parent, isDefault: false, createdAt: `2026-01-0${id.length}`, ...over }) as BranchInfo;

describe('graph git helpers', () => {
  it('arranges branches under their parents, default first', () => {
    const list = [
      branch('feat-b', 'main', { createdAt: '2026-01-03' }),
      branch('main', null, { isDefault: true, createdAt: '2026-01-01' }),
      branch('feat-a', 'main', { createdAt: '2026-01-02' }),
      branch('child', 'feat-a', { createdAt: '2026-01-04' }),
    ];
    expect(branchTree(list).map((x) => `${x.depth}:${x.branch.id}`)).toEqual(['0:main', '1:feat-a', '2:child', '1:feat-b']);
  });

  it('labels commits and summarises changes in words', () => {
    expect(commitLabel({ seq: 7 })).toBe('#007');
    const s: ChangeSummary = { nodesAdded: 1, nodesRemoved: 0, nodesModified: 2, depsAdded: 0, depsRemoved: 3, depsModified: 0, behavioural: 1, moved: 0, lines: [] };
    expect(summaryText(s)).toBe('+1 asset, 2 assets edited, −3 dependencies, 1 behaviour change');
    expect(summaryText({ ...s, nodesAdded: 0, nodesModified: 0, depsRemoved: 0, behavioural: 0 })).toBe('No changes');
  });

  it('compares graph content and ignores positions', () => {
    const a = { assets: [asset('a'), asset('b')], dependencies: [dep('b', 'a')] };
    const b = { assets: [asset('b'), asset('a', { x: 5, y: 5 })], dependencies: [dep('b', 'a')] };
    expect(sameGraphContent(a, b)).toBe(true);
    expect(sameGraphContent(a, { ...b, dependencies: [dep('b', 'a', 'alternate')] })).toBe(false);
    expect(sameGraphContent(a, { ...b, assets: [asset('b'), asset('a', { criticality: 'high' })] })).toBe(false);
    expect(sameGraphContent(a, { assets: a.assets, dependencies: [] })).toBe(false);
  });
});
