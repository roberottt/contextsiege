// Upgrade definitions shared by the server (validates purchases) and the game (applies effects).

import { DEFAULT_SHIP, shipById } from './ships.js';

export const UPGRADES = [
  { id: 'damage',    icon: '⚔', name: 'Damage',           desc: '+30% damage per shot',                                 base: 4000,  growth: 1.45 },
  { id: 'firerate',  icon: '≫', name: 'Fire rate',        desc: '+15% shots per second',                                base: 5000,  growth: 1.5 },
  { id: 'turn',      icon: '↻', name: 'Thrusters',        desc: '+20% ship turning speed',                              base: 3000,  growth: 1.6, max: 8 },
  { id: 'core',      icon: '⬢', name: 'Armor',            desc: '+30% core health and regeneration',                    base: 6000,  growth: 1.5 },
  { id: 'crit',      icon: '✦', name: 'Critical',         desc: '+5% critical hit chance (x3)',                         base: 8000,  growth: 1.6, max: 14 },
  { id: 'pierce',    icon: '➶', name: 'Piercing',         desc: 'Shots pass through +1 enemy',                          base: 15000, growth: 2.2, max: 6 },
  { id: 'multishot', icon: '⋔', name: 'Multishot',        desc: '+1 projectile per volley',                             base: 25000, growth: 2.6, max: 6 },
  { id: 'drones',    icon: '◈', name: 'Orbital drone',    desc: '+1 drone that shoots the nearest enemy',               base: 30000, growth: 2.4, max: 6 },
  { id: 'chain',     icon: 'ϟ', name: 'Context arc',      desc: '+8% chance of lightning that jumps between enemies',   base: 40000, growth: 2.3, max: 8 },
  { id: 'overclock', icon: '✺', name: 'Claude overclock', desc: '+15% damage and fire rate while Claude is generating', base: 20000, growth: 1.9, max: 10 },
];

export function upgradeCost(u, level) {
  return Math.round(u.base * Math.pow(u.growth, level));
}

const MAX_FIRE_RATE = 18;

export function computeStats(levels = {}, generating = false, shipId = DEFAULT_SHIP) {
  const L = (id) => levels[id] || 0;
  const m = shipById(shipId).mods;
  const overclock = generating ? 1.2 + 0.15 * L('overclock') : 1;
  let dmg = Math.pow(1.3, L('damage')) * overclock * (m.dmg ?? 1);
  let fireRate = 2.5 * Math.pow(1.15, L('firerate')) * overclock * (m.fireRate ?? 1);
  // Above the fire rate cap, the excess is converted into damage.
  if (fireRate > MAX_FIRE_RATE) {
    dmg *= fireRate / MAX_FIRE_RATE;
    fireRate = MAX_FIRE_RATE;
  }
  return {
    dmg,
    fireRate,
    overclock,
    turnSpeed: 2.2 * Math.pow(1.2, L('turn')) * (m.turn ?? 1),
    coreMax: 100 * (1 + 0.3 * L('core')) * (m.core ?? 1),
    coreRegen: 0.8 * L('core'),
    critChance: Math.min(0.05 * L('crit') + (m.crit ?? 0), 0.8),
    critMult: 3,
    pierce: L('pierce'),
    shots: 1 + L('multishot') + (m.shots ?? 0),
    spread: 0.09 * (m.spread ?? 1),
    drones: L('drones'),
    droneDmg: dmg * 0.45,
    droneRate: 1.4,
    chainChance: 0.08 * L('chain'),
    chainJumps: 2 + Math.floor(L('chain') / 2),
  };
}
