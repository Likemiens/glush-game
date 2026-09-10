import { z } from 'zod';
import { buyUpgrade, regionLock, settleContracts } from './campaign';
import { installModule, RULES, STORIES, settleStories } from './features';
import { Simulation } from './simulation';
import { World } from './world';
import { surveyRestore, surveyEncode } from './snapshot';
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('depart'), region: z.number().int().min(0).max(6) }),
  z.object({ type: z.literal('upgrade'), id: z.enum(['engine', 'tires', 'lamps', 'rack', 'scanner', 'winch', 'armor', 'battery']) }),
  z.object({ type: z.literal('module'), id: z.enum(['winch', 'plow', 'scanner', 'light', 'rack', 'padding', 'battery', 'rescue']) }),
  z.object({ type: z.literal('rule'), id: z.enum(['normal', 'night', 'fog', 'fragile', 'convoy', 'battery', 'silent']) }),
  z.object({ type: z.literal('radio'), index: z.number().int().min(0).max(2) }),
  z.object({ type: z.literal('move'), index: z.number().int().min(0).max(17), x: z.number().int().min(0).max(3), y: z.number().int().min(0).max(8), rotation: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal('drop'), index: z.number().int().min(-1).max(17) }),
  z.object({ type: z.literal('last'), accept: z.boolean() }),
  ...(['pack', 'load', 'board', 'lights', 'home', 'evacuate', 'interact'] as const).map(type => z.object({ type: z.literal(type) })),
]);
export type Command = z.infer<typeof commandSchema>;
export function execute(sim: Simulation, command: Command): Simulation {
  const c = sim.campaign;
  switch (command.type) {
    case 'depart': {
      if (!sim.docked || regionLock(c, command.region)) return sim;
      sim.rememberWorld(); c.survey[sim.world.region] = surveyEncode(sim.world);
      const world = new World(c.seed, command.region, c.day); surveyRestore(world, c.survey[command.region]);
      const next = new Simulation(world, c); next.headlights = sim.headlights; next.launch(); return next;
    }
    case 'upgrade': if (sim.docked && buyUpgrade(c, command.id)) { const r = { credits: 0, research: 0, delivered: 0, rescued: 0, lost: false, messages: [] as string[] }; settleContracts(c, r); sim.receipt = r; sim.hull = sim.maxHull; } break;
    case 'module': if (sim.docked) installModule(c, command.id); break;
    case 'rule': if (sim.docked && c.relics.filter(Boolean).length >= RULES[command.id].tier) c.progression.rule = command.id; break;
    case 'radio': {
      if (STORIES[command.index].chapters[c.progression.radio.chapters[command.index]]) c.progression.radio.accepted[command.index] = true;
      if (sim.docked) { const r = { credits: 0, research: 0, delivered: 0, rescued: 0, lost: false, messages: [] as string[] }; settleStories(c, r); sim.receipt = r; }
      break;
    }
    case 'move': sim.moveCargo(command.index, command); break;
    case 'drop': sim.dropCargo(command.index); break;
    case 'pack': sim.packCargo(); break;
    case 'load': sim.loadCarried(); break;
    case 'board': if (!sim.docked && !sim.driving && !sim.carried && sim.nearCar) { sim.driving = true; Object.assign(sim.player, { x: sim.car.x, y: sim.car.y, vx: 0, vy: 0 }); sim.route = []; } break;
    case 'last': sim.answerLast(command.accept); break;
    case 'lights': sim.headlights = !sim.headlights; break;
    case 'home': sim.returning = !sim.returning; break;
    case 'evacuate': sim.finish(true); break;
    case 'interact': sim.interact(); break;
  }
  return sim;
}
