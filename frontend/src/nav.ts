import type { IconName } from './components/Icon';

export interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  summary: string;
}

/** The working screens, in the order of the investigation workflow. */
export const WORKFLOW: NavItem[] = [
  { path: '/app/scenarios', label: 'Scenario workspace', icon: 'scenarios', summary: 'Map assets and the dependencies between them.' },
  { path: '/app/graph', label: 'Dependency graph', icon: 'graph', summary: 'See the whole system and what each asset relies on.' },
  { path: '/app/graph-git', label: 'Graph Git', icon: 'branch', summary: 'Branch, commit and simulate versions of the graph without touching main.' },
  { path: '/app/investigation', label: 'Investigation', icon: 'investigate', summary: 'Find dependencies shared in ways the diagram does not show.' },
  { path: '/app/simulation', label: 'Simulation', icon: 'simulate', summary: 'Fail assets and watch the cascade unfold round by round.' },
  { path: '/app/features', label: 'Graph features', icon: 'features', summary: 'Extract centrality, depth and cascade-reach features from any graph.' },
  { path: '/app/mitigation', label: 'Mitigation comparison', icon: 'mitigation', summary: 'Add backups and compare how much each one actually prevents.' },
  { path: '/app/reports', label: 'Reports', icon: 'reports', summary: 'Export findings as Markdown, JSON or print.' },
];

export const DASHBOARD: NavItem = {
  path: '/app/dashboard',
  label: 'Dashboard',
  icon: 'dashboard',
  summary: 'Where your active scenario stands.',
};

export const SETTINGS: NavItem = {
  path: '/app/settings',
  label: 'Settings',
  icon: 'settings',
  summary: 'Motion, density and data.',
};

export const INTEGRATIONS: NavItem = {
  path: '/app/integrations',
  label: 'Integrations',
  icon: 'integrations',
  summary: 'Optional AI, dataset and experiment-tracking services.',
};

export const APP_NAV: NavItem[] = [DASHBOARD, ...WORKFLOW, INTEGRATIONS, SETTINGS];
