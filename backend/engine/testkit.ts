import type { Asset, Dependency } from './types';

export const asset = (id: string, over: Partial<Asset> = {}): Asset => ({ id, name: id, kind: 'service', criticality: 'medium', notes: '', ...over });
export const dep = (dependentId: string, providerId: string, mode: Dependency['mode'] = 'required', over: Partial<Dependency> = {}): Dependency => ({
  id: `${dependentId}-${providerId}`,
  dependentId,
  providerId,
  mode,
  status: 'confirmed',
  relation: 'service',
  notes: '',
  ...over,
});
export const assetsOf = (...ids: string[]) => ids.map((id) => asset(id));
