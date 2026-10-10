// Ship catalog shared by the server (validates purchases) and the game (model, sound and modifiers).
// mods: multipliers applied to upgrade stats (shots and crit are added instead).

export const SHIPS = [
  {
    id: 'arrow', name: 'Arrow', price: 0,
    desc: 'Balanced stock fighter.',
    mods: {},
    bullet: 0x67e8f9,
    sound: { freq: 880, slide: -500, type: 'square', dur: 0.05, vol: 0.016 },
  },
  {
    id: 'hornet', name: 'Hornet', price: 50000,
    desc: 'Light gunship: fires very fast, but each bullet hits softer.',
    mods: { fireRate: 1.45, dmg: 0.8, turn: 1.25 },
    bullet: 0xfde047,
    sound: { freq: 1500, slide: -700, type: 'square', dur: 0.035, vol: 0.012 },
  },
  {
    id: 'bastion', name: 'Bastion', price: 120000,
    desc: 'Slow heavy cannon that also reinforces the core.',
    mods: { dmg: 1.7, fireRate: 0.7, turn: 0.85, core: 1.25 },
    bullet: 0xfb923c,
    sound: { freq: 240, slide: -150, type: 'sawtooth', dur: 0.12, vol: 0.03 },
  },
  {
    id: 'manta', name: 'Manta', price: 250000,
    desc: 'Fires in a fan: +2 projectiles per volley, slightly less damage.',
    mods: { shots: 2, dmg: 0.85, spread: 1.7 },
    bullet: 0xc084fc,
    sound: { freq: 620, slide: -260, type: 'triangle', dur: 0.07, vol: 0.03 },
  },
  {
    id: 'opus', name: 'Opus', price: 800000,
    desc: 'Flagship: +25% to everything and +10% crit chance.',
    mods: { dmg: 1.25, fireRate: 1.25, turn: 1.25, core: 1.25, crit: 0.1 },
    bullet: 0xfbbf24,
    sound: { freq: 1050, slide: 500, type: 'sine', dur: 0.07, vol: 0.035 },
  },
];

export const DEFAULT_SHIP = 'arrow';

export const shipById = (id) => SHIPS.find((s) => s.id === id) || SHIPS[0];

const MOD_LABELS = { dmg: 'Damage', fireRate: 'Fire rate', turn: 'Turning', core: 'Core', shots: 'Projectiles', crit: 'Crit', spread: 'Spread' };

// Short label for each modifier, shown in the hangar.
export function describeMods(mods) {
  return Object.entries(mods).map(([k, v]) => {
    const good = k === 'spread' ? null : v > (k === 'shots' || k === 'crit' ? 0 : 1);
    const text = k === 'shots' ? `+${v}` : k === 'crit' ? `+${Math.round(v * 100)}%` : `×${v}`;
    return { label: `${MOD_LABELS[k]} ${text}`, good };
  });
}
