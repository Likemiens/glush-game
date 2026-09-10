import { Simulation } from '../game/simulation';
import type { Controls, GameEvent } from '../game/simulation';
import type { Campaign } from '../game/campaign';
import { World } from '../game/world';
import { applyTrip, surveyRestore } from '../game/snapshot';
import type { Command } from '../game/commands';
import { makeKey, PROTOCOL } from './protocol';
import type { ActorFrame, ClientMessage, ServerMessage } from './protocol';
export type Identity = { server: string; key: string; name: string };
export type RoomLink = { server: string; id: string; invite?: string };
export function serverAddress(value: string): string {
  const url = new URL(value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Нужен HTTPS-адрес сервера.');
  return url.origin;
}
export function identityFor(server: string): Identity {
  const address = serverAddress(server), saved = localStorage.getItem('glush:identity:' + address);
  if (saved) { const value = JSON.parse(saved) as Identity; if (/^[a-f0-9]{64}$/.test(value.key)) return value; }
  const identity = { server: address, key: makeKey(), name: 'Водитель' }; saveIdentity(identity); return identity;
}
export function saveIdentity(identity: Identity): void {
  if (!/^[a-f0-9]{64}$/.test(identity.key) || !identity.name.trim() || identity.name.length > 24) throw new Error('Неверный файл ключа.');
  localStorage.setItem('glush:identity:' + serverAddress(identity.server), JSON.stringify(identity));
}
export function invitation(link: RoomLink): string {
  const url = new URL(location.origin + location.pathname); url.hash = new URLSearchParams({ room: link.id, server: link.server, ...(link.invite ? { invite: link.invite } : {}) }).toString(); return url.toString();
}
export function parseInvitation(text: string): RoomLink {
  const url = new URL(text), params = new URLSearchParams(url.hash.slice(1)), id = params.get('room');
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('В ссылке нет игрового мира.');
  return { id, server: serverAddress(params.get('server') ?? ''), invite: params.get('invite') ?? undefined };
}
export async function createRoom(server: string, identity: Identity): Promise<RoomLink> {
  const response = await fetch(serverAddress(server) + '/worlds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: identity.key, name: identity.name }) });
  const data = await response.json() as { id: string; invite: string; error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Сервер недоступен.');
  return { server: serverAddress(server), id: data.id, invite: data.invite };
}
export class CoopClient {
  state: 'connecting' | 'online' | 'reconnecting' | 'closed' = 'connecting';
  playerId = '';
  actors: ActorFrame[] = [];
  simulations = new Map<string, Simulation>();
  pings: { x: number; y: number; label: string; ttl: number }[] = [];
  events: GameEvent[] = [];
  onChange = (_refresh: boolean): void => {};
  onError = (_message: string): void => {};
  private socket?: WebSocket;
  private campaign?: Campaign;
  private reconnect?: ReturnType<typeof setTimeout>;
  private retry = 500;
  private stopped = false;
  private seq = 0;
  private operation = 0;
  private sentAt = 0;
  private signalAt = 0;
  private pending = new Map<string, Command>();
  private history: { seq: number; controls: Controls; dt: number }[] = [];
  private pulse = false;
  private dash = false;
  private targets = new Map<string, ActorFrame['trip']>();
  constructor(readonly link: RoomLink, readonly identity: Identity) {}
  get self(): Simulation | undefined { return this.simulations.get(this.playerId); }
  get peers(): Simulation[] { return [...this.simulations.entries()].filter(([id]) => id !== this.playerId).map(([, sim]) => sim); }
  connect(): void {
    const url = this.link.server.replace(/^http/, 'ws') + `/worlds/${this.link.id}/socket`;
    const socket = this.socket = new WebSocket(url);
    socket.onopen = () => this.send({ type: 'hello', version: PROTOCOL, key: this.identity.key, name: this.identity.name, invite: this.link.invite });
    socket.onmessage = event => {
      try { this.receive(JSON.parse(String(event.data)) as ServerMessage); }
      catch { this.onError('Не удалось прочитать состояние мира. Переподключаюсь.'); socket.close(); }
    };
    socket.onclose = event => {
      if (this.stopped) return;
      if (event.code === 4001 || event.code === 1008) { this.state = 'closed'; this.onError(event.code === 4001 ? 'Мир открыт на другом устройстве.' : 'Подключение отклонено. Проверь приглашение.'); this.onChange(false); return; }
      this.state = 'reconnecting'; this.history = []; this.onChange(false);
      this.reconnect = setTimeout(() => this.connect(), this.retry); this.retry = Math.min(15000, this.retry * 1.6);
    };
    socket.onerror = () => { this.onError('Нет связи с сервером. Проверяю подключение.'); };
  }
  private receive(message: ServerMessage): void {
    if (message.type === 'error') { this.onError(message.message); if (message.id) this.socket?.close(); return; }
    if (message.type === 'ack') { this.pending.delete(message.id); this.onChange(true); return; }
    if (message.type === 'welcome') {
      if (message.version !== PROTOCOL) { this.close(); this.onError('Обнови страницу: сервер использует новую версию.'); return; }
      this.playerId = message.playerId; this.state = 'online'; this.retry = 500; this.seq = 0; this.history = [];
    }
    if (message.campaign) this.campaign = message.campaign;
    const campaign = this.campaign; if (!campaign) return;
    const before = this.self, wasDocked = before?.docked, oldRegion = before?.world.region;
    this.actors = message.actors;
    for (const actor of message.actors) {
      let sim = this.simulations.get(actor.id); let fresh = false;
      if (!sim || sim.world.region !== actor.trip.region || sim.world.day !== actor.trip.day) {
        fresh = true; const world = new World(campaign.seed, actor.trip.region, actor.trip.day); surveyRestore(world, campaign.survey[actor.trip.region]);
        sim = new Simulation(world, structuredClone(campaign)); sim.actorId = actor.id; this.simulations.set(actor.id, sim);
      }
      sim.displayName = actor.name; const personal = actor.profile;
      if (message.campaign && !fresh) { Object.assign(sim.campaign, structuredClone(campaign)); surveyRestore(sim.world, campaign.survey[actor.trip.region]); }
      Object.assign(sim.campaign, { credits: personal.credits, research: personal.research, earned: personal.earned, upgrades: personal.upgrades });
      sim.campaign.progression = { ...sim.campaign.progression, owned: personal.owned, modules: personal.modules };
      const old = { ...sim.car }, person = { ...sim.player };
      const pulseBefore = sim.pulseTime; applyTrip(sim, actor.trip);
      if (sim.pulseTime > pulseBefore + .5) sim.ripples.push({x:sim.player.x,y:sim.player.y,life:1.3,maxLife:1.3,radius:156,color:'#c9c178'});
      sim.world.caches.forEach(cache => { cache.collected = sim!.memory.taken.includes(cache.id); cache.discovered = sim!.memory.discovered.includes(cache.id); });
      sim.world.reveal(sim.player.x, sim.player.y, Math.ceil(sim.visibilityRadius));
      if (actor.id === this.playerId) {
        this.operation = Math.max(this.operation, actor.ackCommand);
        for (const id of this.pending.keys()) if (Number(id.split(':').pop()) <= actor.ackCommand) this.pending.delete(id);
        this.history = this.history.filter(h => h.seq > actor.ackInput);
        for (const h of this.history) sim.predictMovement(h.dt, h.controls);
        sim.events = [];
      } else {
        this.targets.set(actor.id, actor.trip);
        if (Math.hypot(old.x - sim.car.x, old.y - sim.car.y) < 100) { Object.assign(sim.car, { x: old.x, y: old.y, angle: old.angle }); Object.assign(sim.player, { x: person.x, y: person.y }); }
      }
    }
    for (const id of this.simulations.keys()) if (!message.actors.some(a => a.id === id)) this.simulations.delete(id);
    if (message.type === 'welcome') {
      const own = message.actors.find(a => a.id === this.playerId)!;
      for (const [id, command] of this.pending) { if (Number(id.split(':').pop()) <= own.ackCommand) this.pending.delete(id); else this.send({ type: 'command', id, command }); }
    } else { this.events.push(...message.events.filter(e => e.type !== 'dock')); this.pings = message.pings; }
    this.onChange(wasDocked !== this.self?.docked || oldRegion !== this.self?.world.region || message.type === 'welcome');
  }
  command(command: Command): void {
    if (this.state !== 'online') { this.onError('Подожди восстановления связи.'); return; }
    const id = `${this.playerId}:${++this.operation}`; this.pending.set(id, command); this.send({ type: 'command', id, command });
  }
  ping(label: 'Сюда' | 'Нужна помощь' | 'Нашёл груз' | 'Возвращаюсь' | 'Зацепить трос' | 'Отцепить трос'): void { if (this.state === 'online') this.send({ type: 'ping', label }); }
  private send(message: ClientMessage): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  update(dt: number, controls: Controls): void {
    if (this.state !== 'online') return;
    if (controls.interact) this.command({ type: 'interact' });
    if (controls.home) this.command({ type: 'home' });
    if (controls.lights) this.command({ type: 'lights' });
    this.pulse ||= controls.pulse; this.dash ||= controls.dash;
    const now = performance.now();
    if (this.self && !this.self.docked && now >= this.signalAt) { const signal=this.self.signal; if(signal) { this.events.push({type:'signal',strength:signal.strength,pan:Math.cos(signal.angle)}); this.signalAt=now+(1.5-signal.strength*1.25)*1000; } }
    if (now - this.sentAt >= 50) {
      this.sentAt = now; this.seq++;
      this.send({ type: 'input', seq: this.seq, controls: { ...controls, pulse: this.pulse, dash: this.dash, interact: false } }); this.pulse = this.dash = false;
    }
    if (this.self && !this.self.docked) {
      this.self.predictMovement(dt, controls); this.history.push({ seq: this.seq, controls: { ...controls }, dt }); this.history = this.history.slice(-120);
    }
    for (const [id, target] of this.targets) {
      const sim = this.simulations.get(id); if (!sim) continue;
      const oldCar = { ...sim.car }; const f = 1 - Math.exp(-dt * 16);
      sim.car.x += (target.car.x - sim.car.x) * f; sim.car.y += (target.car.y - sim.car.y) * f;
      sim.car.angle += Math.atan2(Math.sin(target.car.angle - sim.car.angle), Math.cos(target.car.angle - sim.car.angle)) * f;
      sim.player.x += (target.player.x - sim.player.x) * f; sim.player.y += (target.player.y - sim.player.y) * f; sim.time += dt;
      sim.updateEffects(dt);
      if (Math.hypot(sim.car.x-oldCar.x,sim.car.y-oldCar.y) > .5) {
        for (const side of [-1,1]) { const dx=-Math.sin(sim.car.angle)*3*side,dy=Math.cos(sim.car.angle)*3*side; sim.tracks.push({ax:oldCar.x+dx,ay:oldCar.y+dy,bx:sim.car.x+dx,by:sim.car.y+dy,life:12,maxLife:12,water:false,strong:target.car.boosting}); }
        if (Math.random()<.35) sim.burst(sim.car.x-Math.cos(sim.car.angle)*6,sim.car.y-Math.sin(sim.car.angle)*6,'#c0ab8d',2,12);
      }
    }
  }
  async exportWorld(): Promise<unknown> {
    const response = await fetch(`${this.link.server}/worlds/${this.link.id}/export`, { headers: { Authorization: `Bearer ${this.identity.key}` } });
    if (!response.ok) throw new Error('Не удалось экспортировать мир.'); return response.json();
  }
  close(): void { this.stopped = true; this.state = 'closed'; clearTimeout(this.reconnect); this.socket?.close(); }
}
