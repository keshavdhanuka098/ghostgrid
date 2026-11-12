/**
 * Google Maps is deliberately NOT wired up. GhostGrid's data model has no geographic coordinates (assets only carry
 * optional x/y positions for the diagram layout, and "regional" is just a sector label), so a map would require
 * inventing locations. This module records that decision so the integration list can explain it honestly.
 *
 * To enable maps later, the scenario model first needs real, user-entered latitude/longitude on assets (a migration
 * plus editor fields); only then does a Maps JavaScript API layer make sense. GOOGLE_MAPS_API_KEY is read nowhere else.
 */
export function describeMaps() {
  return {
    supported: false,
    reason: 'GhostGrid assets have no geographic coordinates, and coordinates must never be invented. The map module stays disabled until assets can store real locations.',
    wouldNeed: ['Optional latitude/longitude on assets, entered by the user', 'A Maps JavaScript API key restricted by HTTP referrer'],
  };
}
