import { z } from 'zod';
import { commandSchema } from '../game/commands';
import type { Campaign } from '../game/campaign';
import type { TripSnapshot } from '../game/snapshot';
import type { GameEvent } from '../game/simulation';
export const PROTOCOL = 1;
const number = z.number().finite();
export const controlsSchema = z.object({ x: number.min(-1).max(1), y: number.min(-1).max(1), boost: z.boolean(), brake: z.boolean(), dash: z.boolean(), interact: z.boolean(), pulse: z.boolean(), home: z.boolean().optional(), lights: z.boolean().optional() });
export const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.literal(PROTOCOL), key: z.string().regex(/^[a-f0-9]{64}$/), invite: z.string().max(100).optional(), name: z.string().trim().min(1).max(24) }),
  z.object({ type: z.literal('input'), seq: number.int().min(0).max(Number.MAX_SAFE_INTEGER), controls: controlsSchema }),
  z.object({ type: z.literal('command'), id: z.string().min(1).max(80), command: commandSchema }),
  z.object({ type: z.literal('ping'), label: z.enum(['Сюда', 'Нужна помощь', 'Нашёл груз', 'Возвращаюсь', 'Зацепить трос', 'Отцепить трос']) }),
]);
export type ClientMessage = z.infer<typeof messageSchema>;
export type ActorFrame = { id: string; name: string; online: boolean; ready: number | null; ackInput: number; ackCommand: number; trip: TripSnapshot; profile: PlayerProfile; towTarget?: string };
export type PlayerProfile = Pick<Campaign, 'credits' | 'research' | 'earned' | 'upgrades'> & Pick<Campaign['progression'], 'owned' | 'modules'>;
export type ServerMessage =
  | { type: 'welcome'; version: number; playerId: string; roomId: string; campaign: Campaign; actors: ActorFrame[]; tick: number; revision: number }
  | { type: 'frame'; actors: ActorFrame[]; tick: number; revision: number; events: GameEvent[]; campaign?: Campaign; pings: { x: number; y: number; label: string; ttl: number }[] }
  | { type: 'ack'; id: string; revision: number }
  | { type: 'error'; message: string; id?: string };
export const createWorldSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(24), seed: z.string().min(1).max(40).optional() });
export function makeKey(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
export async function hashKey(key: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), b => b.toString(16).padStart(2, '0')).join(''); }
