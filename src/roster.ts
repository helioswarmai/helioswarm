// Turns config groups into concrete agents, built from the same psychology
// presets and roster personas the AgentChain engine uses.
import { readFileSync } from "node:fs";

import { GOAL_BY_PRESET, nearestPreset, PSYCHOLOGIES, TEMPERAMENT_BY_PRESET, type GoalId, type PsychologyId, type Temperament, type TradingRules, type Traits } from "./types";

import type { BrainKind, GroupConfig, Target } from "./config";

export interface RosterEntry {
  name: string;
  preset?: PsychologyId;
  persona: string;
  goal?: GoalId;
  tilt?: number;
  regret?: number;
  traits?: Partial<Traits>;
  rules?: TradingRules;
}

export interface AgentSpec {
  id: string;
  name: string;
  preset: PsychologyId;
  persona: string;
  goal: GoalId;
  traits: Omit<Traits, "aesthetic">;
  temperament: Temperament;
  bankrollSol: number;
  targets: Target[];
  tasks: string[];
  rules: TradingRules;
  brain: BrainKind;
  /** Index of the group it came from. Each agent still has its own wallet. */
  group: number;
  taskOptions: Record<string, Record<string, unknown>>;
}

const ROSTER_URL = new URL("../data/sim-agents.json", import.meta.url);
let cached: RosterEntry[] | null = null;

/** The engine's seeded agents (name, preset, persona, traits, rules). */
export function loadRoster(): RosterEntry[] {
  cached ??= JSON.parse(readFileSync(ROSTER_URL, "utf8")) as RosterEntry[];
  return cached;
}

const presetOf = (id: PsychologyId) => PSYCHOLOGIES.find((p) => p.id === id)!;

export function expandGroups(groups: GroupConfig[], roster: RosterEntry[] = loadRoster()): AgentSpec[] {
  const out: AgentSpec[] = [];
  const seen = new Set<string>();
  groups.forEach((g, gi) => {
    const base = { bankrollSol: g.bankrollSol, targets: g.targets, tasks: g.tasks, brain: g.brain ?? "traits", group: gi, taskOptions: g.taskOptions ?? {} } as const;
    for (const name of g.roster ?? []) {
      const r = roster.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!r) throw new Error(`no roster agent named "${name}"`);
      const preset = r.preset ?? nearestPreset(r.traits ?? {});
      out.push({
        ...base,
        id: unique(r.name, seen),
        name: r.name,
        preset,
        persona: r.persona,
        goal: r.goal ?? GOAL_BY_PRESET[preset],
        traits: { ...presetOf(preset).traits, ...r.traits },
        temperament: { ...TEMPERAMENT_BY_PRESET[preset], ...(r.tilt != null ? { tilt: r.tilt } : {}), ...(r.regret != null ? { regret: r.regret } : {}) },
        // Group rules override the roster agent's own.
        rules: { ...r.rules, ...g.rules },
      });
    }
    if (g.preset) {
      const p = presetOf(g.preset);
      for (let i = 0; i < (g.count ?? 1); i++) {
        const name = `${g.namePrefix ?? p.id}-${i + 1}`;
        out.push({
          ...base,
          id: unique(name, seen),
          name,
          preset: p.id,
          persona: g.persona ?? `${p.name}: ${p.summary}`,
          goal: GOAL_BY_PRESET[p.id],
          traits: { ...p.traits },
          temperament: { ...TEMPERAMENT_BY_PRESET[p.id] },
          rules: { ...g.rules },
        });
      }
    }
  });
  return out;
}

function unique(name: string, seen: Set<string>): string {
  let id = name;
  for (let n = 2; seen.has(id); n++) id = `${name}#${n}`;
  seen.add(id);
  return id;
}
