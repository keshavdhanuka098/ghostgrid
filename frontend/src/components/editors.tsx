import { useState, type FormEvent } from 'react';
import {
  addAsset,
  addAssumption,
  addDependency,
  updateAsset,
  updateAssumption,
  updateDependency,
  validateAsset,
  validateAssumption,
  validateDependency,
} from '../lib/scenarioOps';
import {
  ASSET_KINDS,
  CONFIDENCES,
  CONFIDENCE_LABEL,
  CRITICALITIES,
  CRIT_LABEL,
  KIND_LABEL,
  LINK_STATUSES,
  RELATIONS,
  RELATION_LABEL,
  STATUS_GLYPH,
  STATUS_HELP,
  STATUS_LABEL,
  type Asset,
  type AssetKind,
  type Assumption,
  type AssumptionTarget,
  type Confidence,
  type Criticality,
  type Dependency,
  type DependencyMode,
  type LinkStatus,
  type Relation,
  type Scenario,
} from '../lib/types';
import { useScenarios } from '../state/ScenarioContext';
import { useToast } from '../state/ToastContext';
import { Badge, Button, Dialog, SelectField, TextAreaField, TextField } from './ui';

/** Status badge with its glyph, so status is readable without colour. */
export function StatusBadge({ status }: { status: LinkStatus }) {
  return (
    <Badge tone={status === 'confirmed' ? 'signal' : status === 'inferred' ? 'medium' : undefined}>
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span> {STATUS_LABEL[status]}
    </Badge>
  );
}

const byName = (assets: Asset[]) => [...assets].sort((a, b) => a.name.localeCompare(b.name));

/* ------------------------------------------------------------------ asset */

interface AssetDialogProps {
  open: boolean;
  onClose: () => void;
  scenario: Scenario;
  editing?: Asset;
  /** Where to place a new asset on the graph canvas. */
  position?: { x: number; y: number };
  onSaved?: (asset: Asset) => void;
}

export function AssetDialog(props: AssetDialogProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title={props.editing ? 'Edit asset' : 'Add asset'}>
      {props.open && <AssetForm {...props} />}
    </Dialog>
  );
}

function AssetForm({ onClose, scenario, editing, position, onSaved }: AssetDialogProps) {
  const { updateScenario } = useScenarios();
  const toast = useToast();
  const [name, setName] = useState(editing?.name ?? '');
  const [kind, setKind] = useState<AssetKind>(editing?.kind ?? 'power');
  const [criticality, setCriticality] = useState<Criticality>(editing?.criticality ?? 'medium');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [errors, setErrors] = useState<ReturnType<typeof validateAsset>>({});

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const e = validateAsset({ name, notes }, scenario, editing?.id);
    setErrors(e);
    if (Object.keys(e).length) return;
    const values = { name, kind, criticality, notes };
    let saved: Asset | undefined;
    updateScenario(scenario.id, (s) => {
      if (editing) {
        const next = updateAsset(s, editing.id, values);
        saved = next.assets.find((a) => a.id === editing.id);
        return next;
      }
      const r = addAsset(s, values, position);
      saved = r.asset;
      return r.scenario;
    });
    toast.success(editing ? `Updated “${name.trim()}”.` : `Added “${name.trim()}”.`);
    if (saved) onSaved?.(saved);
    onClose();
  };

  return (
    <form onSubmit={submit} noValidate className="stack">
      <TextField label="Name" value={name} maxLength={70} autoFocus placeholder="e.g. North substation" error={errors.name} onChange={(e) => setName(e.target.value)} />
      <div className="form-grid">
        <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
          {ASSET_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Criticality" value={criticality} onChange={(e) => setCriticality(e.target.value as Criticality)}>
          {CRITICALITIES.map((c) => (
            <option key={c} value={c}>
              {CRIT_LABEL[c]}
            </option>
          ))}
        </SelectField>
      </div>
      <TextAreaField label="Notes (optional)" value={notes} hint={`${notes.length}/200`} error={errors.notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          {editing ? 'Save asset' : 'Add asset'}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- dependency */

interface DependencyDialogProps {
  open: boolean;
  onClose: () => void;
  scenario: Scenario;
  editing?: Dependency;
  /** Pre-selected assets, for example when connecting two assets on the graph. */
  preset?: { dependentId?: string; providerId?: string };
  onSaved?: (dependency: Dependency) => void;
}

export function DependencyDialog(props: DependencyDialogProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title={props.editing ? 'Edit dependency' : 'Add dependency'}>
      {props.open && <DependencyForm {...props} />}
    </Dialog>
  );
}

function DependencyForm({ onClose, scenario, editing, preset, onSaved }: DependencyDialogProps) {
  const { updateScenario } = useScenarios();
  const toast = useToast();
  const [dependentId, setDependentId] = useState(editing?.dependentId ?? preset?.dependentId ?? '');
  const [providerId, setProviderId] = useState(editing?.providerId ?? preset?.providerId ?? '');
  const [relation, setRelation] = useState<Relation>(editing?.relation ?? 'power');
  const [status, setStatus] = useState<LinkStatus>(editing?.status ?? 'confirmed');
  const [mode, setMode] = useState<DependencyMode>(editing?.mode ?? 'required');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [errors, setErrors] = useState<ReturnType<typeof validateDependency>>({});
  const sorted = byName(scenario.assets);
  const name = (id: string) => scenario.assets.find((a) => a.id === id)?.name ?? 'Unknown';

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const e = validateDependency({ dependentId, providerId, notes }, scenario, editing?.id);
    setErrors(e);
    if (Object.keys(e).length) return;
    const values = { dependentId, providerId, mode, status, relation, notes };
    let saved: Dependency | undefined;
    updateScenario(scenario.id, (s) => {
      if (editing) {
        const next = updateDependency(s, editing.id, values);
        saved = next.dependencies.find((d) => d.id === editing.id);
        return next;
      }
      const r = addDependency(s, values);
      saved = r.dependency;
      return r.scenario;
    });
    toast.success(editing ? 'Dependency updated.' : `${name(dependentId)} now relies on ${name(providerId)}.`);
    if (saved) onSaved?.(saved);
    onClose();
  };

  return (
    <form onSubmit={submit} noValidate className="stack">
      <div className="form-grid">
        <SelectField label="This asset…" value={dependentId} error={errors.dependentId} autoFocus onChange={(e) => setDependentId(e.target.value)}>
          <option value="">Choose asset</option>
          {sorted.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="…relies on" value={providerId} error={errors.providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">Choose asset</option>
          {sorted.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Relationship" value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
          {RELATIONS.map((r) => (
            <option key={r} value={r}>
              {RELATION_LABEL[r]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Type" value={mode} onChange={(e) => setMode(e.target.value as DependencyMode)} hint={mode === 'required' ? 'Fails if the provider fails.' : 'Fails only if every alternate provider fails.'}>
          <option value="required">Required</option>
          <option value="alternate">Alternate (backup)</option>
        </SelectField>
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as LinkStatus)} hint={STATUS_HELP[status]} className="span-2">
          {LINK_STATUSES.map((st) => (
            <option key={st} value={st}>
              {STATUS_GLYPH[st]} {STATUS_LABEL[st]}
            </option>
          ))}
        </SelectField>
        <TextAreaField label="Notes and evidence (optional)" value={notes} hint={`${notes.length}/300`} error={errors.notes} className="span-2" placeholder="How do you know? Where is this documented?" onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          {editing ? 'Save dependency' : 'Add dependency'}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- assumption */

interface AssumptionDialogProps {
  open: boolean;
  onClose: () => void;
  scenario: Scenario;
  editing?: Assumption;
  preset?: { targetType: AssumptionTarget; targetId: string | null };
}

export function AssumptionDialog(props: AssumptionDialogProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title={props.editing ? 'Edit assumption' : 'Add assumption'}>
      {props.open && <AssumptionForm {...props} />}
    </Dialog>
  );
}

function AssumptionForm({ onClose, scenario, editing, preset }: AssumptionDialogProps) {
  const { updateScenario } = useScenarios();
  const toast = useToast();
  const initial = editing ?? preset ?? { targetType: 'scenario' as AssumptionTarget, targetId: null };
  const [text, setText] = useState(editing?.text ?? '');
  const [targetType, setTargetType] = useState<AssumptionTarget>(initial.targetType);
  const [targetId, setTargetId] = useState<string>(initial.targetId ?? '');
  const [confidence, setConfidence] = useState<Confidence>(editing?.confidence ?? 'medium');
  const [errors, setErrors] = useState<{ text?: string; target?: string }>({});
  const name = (id: string) => scenario.assets.find((a) => a.id === id)?.name ?? 'Unknown';

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const e: typeof errors = { ...validateAssumption({ text }) };
    if (targetType !== 'scenario' && !targetId) e.target = targetType === 'node' ? 'Choose the asset this is about.' : 'Choose the dependency this is about.';
    setErrors(e);
    if (Object.keys(e).length) return;
    const values = { text, targetType, targetId: targetType === 'scenario' ? null : targetId, confidence };
    updateScenario(scenario.id, (s) => (editing ? updateAssumption(s, editing.id, values) : addAssumption(s, values)));
    toast.success(editing ? 'Assumption updated.' : 'Assumption recorded.');
    onClose();
  };

  return (
    <form onSubmit={submit} noValidate className="stack">
      <TextAreaField label="Assumption" value={text} autoFocus maxLength={400} hint={`${text.length}/400`} error={errors.text} placeholder="e.g. The backup generator can run for 24 hours." onChange={(e) => setText(e.target.value)} />
      <div className="form-grid">
        <SelectField
          label="About"
          value={targetType}
          onChange={(e) => {
            setTargetType(e.target.value as AssumptionTarget);
            setTargetId('');
          }}
        >
          <option value="scenario">The whole scenario</option>
          <option value="node">An asset</option>
          <option value="link">A dependency</option>
        </SelectField>
        <SelectField label="Confidence" value={confidence} onChange={(e) => setConfidence(e.target.value as Confidence)}>
          {CONFIDENCES.map((c) => (
            <option key={c} value={c}>
              {CONFIDENCE_LABEL[c]}
            </option>
          ))}
        </SelectField>
        {targetType === 'node' && (
          <SelectField label="Asset" value={targetId} error={errors.target} className="span-2" onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Choose asset</option>
            {byName(scenario.assets).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </SelectField>
        )}
        {targetType === 'link' && (
          <SelectField label="Dependency" value={targetId} error={errors.target} className="span-2" onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Choose dependency</option>
            {scenario.dependencies.map((d) => (
              <option key={d.id} value={d.id}>
                {name(d.dependentId)} relies on {name(d.providerId)}
              </option>
            ))}
          </SelectField>
        )}
      </div>
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          {editing ? 'Save assumption' : 'Add assumption'}
        </Button>
      </div>
    </form>
  );
}
