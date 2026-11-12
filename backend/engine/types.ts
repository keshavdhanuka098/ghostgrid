// "Asset" is the UI word for a graph node; "dependency" is a directed link. The database tables are named
// nodes and links, and the API documents carry them as `assets` and `dependencies`.

export const ASSET_KINDS = ['power', 'network', 'compute', 'data', 'water', 'transport', 'service', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const KIND_LABEL: Record<AssetKind, string> = {
  power: 'Power',
  network: 'Network',
  compute: 'Compute',
  data: 'Data',
  water: 'Water',
  transport: 'Transport',
  service: 'Service',
  other: 'Other',
};

export const KIND_CODE: Record<AssetKind, string> = {
  power: 'PWR',
  network: 'NET',
  compute: 'CMP',
  data: 'DAT',
  water: 'WTR',
  transport: 'TRN',
  service: 'SVC',
  other: 'OTH',
};

export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const CRIT_LABEL: Record<Criticality, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const CRIT_WEIGHT: Record<Criticality, number> = { low: 1, medium: 2, high: 4, critical: 8 };

export const SECTORS = [
  'Energy',
  'Telecommunications',
  'Water',
  'Transport',
  'Healthcare',
  'Finance',
  'Mixed / regional',
] as const;

/** required: the dependent fails if this provider fails. alternate: the dependent fails only if all of its alternate providers fail. */
export type DependencyMode = 'required' | 'alternate';

/** How well a relationship is known. All three are included when failures are simulated. */
export const LINK_STATUSES = ['confirmed', 'inferred', 'unknown'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const STATUS_LABEL: Record<LinkStatus, string> = {
  confirmed: 'Confirmed',
  inferred: 'Inferred',
  unknown: 'Unknown',
};

export const STATUS_HELP: Record<LinkStatus, string> = {
  confirmed: 'Verified from documentation, a survey or testing.',
  inferred: 'Believed to exist based on indirect evidence. Not verified.',
  unknown: 'Might exist. Nobody has checked. Treated as live, to be cautious.',
};

/** Glyph shown on graph links, so status never relies on colour alone. */
export const STATUS_GLYPH: Record<LinkStatus, string> = { confirmed: '✓', inferred: '~', unknown: '?' };

export const RELATIONS = ['power', 'data', 'network', 'control', 'physical', 'service', 'other'] as const;
export type Relation = (typeof RELATIONS)[number];

export const RELATION_LABEL: Record<Relation, string> = {
  power: 'Supplies power',
  data: 'Provides data',
  network: 'Provides connectivity',
  control: 'Provides control or telemetry',
  physical: 'Physical or co-location',
  service: 'Provides a service',
  other: 'Other',
};

export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCES)[number];
export const CONFIDENCE_LABEL: Record<Confidence, string> = { low: 'Low confidence', medium: 'Medium confidence', high: 'High confidence' };

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  criticality: Criticality;
  notes: string;
  /** Pinned position on the graph canvas. null/undefined means the automatic layout decides. */
  x?: number | null;
  y?: number | null;
}

export interface Dependency {
  id: string;
  /** The asset that relies on the provider. */
  dependentId: string;
  providerId: string;
  mode: DependencyMode;
  status: LinkStatus;
  relation: Relation;
  notes: string;
}

export interface SavedRun {
  id: string;
  name: string;
  /** Assets that fail at the start. */
  failedIds: string[];
  /** Dependency links that fail at the start (the provider stops serving that one dependent). */
  failedLinkIds: string[];
  createdAt: string;
}

/** backup: the dependent gains an alternate provider. decouple: the dependent stops relying on the provider. */
export const MITIGATION_KINDS = ['backup', 'decouple'] as const;
export type MitigationKind = (typeof MITIGATION_KINDS)[number];

export const MITIGATION_KIND_LABEL: Record<MitigationKind, string> = {
  backup: 'Add a backup provider',
  decouple: 'Remove the dependency',
};

/** Ordinal estimates entered by the user. GhostGrid does not compute them and never converts them to money or time. */
export const ESTIMATE_LEVELS = ['low', 'medium', 'high'] as const;
export type EstimateLevel = (typeof ESTIMATE_LEVELS)[number];

/** A mitigation option anchored on one existing dependency (dependent relies on provider). */
export interface Strategy {
  id: string;
  name: string;
  kind: MitigationKind;
  dependentId: string;
  providerId: string;
  /** The new provider for kind "backup". Empty for "decouple". */
  backupId: string;
  notes?: string;
  /** The user's own rough estimates. Null means not estimated. */
  costLevel: EstimateLevel | null;
  effortLevel: EstimateLevel | null;
}

export type AssumptionTarget = 'scenario' | 'node' | 'link';

export interface Assumption {
  id: string;
  text: string;
  targetType: AssumptionTarget;
  /** Asset id for node, dependency id for link, null for scenario-wide. */
  targetId: string | null;
  confidence: Confidence;
  createdAt: string;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  sector: string;
  /** Non-null for the bundled, simulated samples. */
  sampleKey: string | null;
  isSample: boolean;
  createdAt: string;
  updatedAt: string;
  assets: Asset[];
  dependencies: Dependency[];
  runs: SavedRun[];
  strategies: Strategy[];
  assumptions: Assumption[];
}

export interface ReportSummary {
  id: string;
  scenarioId: string;
  title: string;
  createdAt: string;
}
