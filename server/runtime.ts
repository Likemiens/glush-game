import { Room } from './room';
import type { WorldState } from './room';
import { messageSchema, PROTOCOL } from '../src/net/protocol';
import type { ServerMessage } from '../src/net/protocol';
export type Peer = { send: (data: string) => void; close: (code: number, reason: string) => void };
export class RoomRuntime {
  peers = new Map<Peer, string>();
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private previous = Date.now();
  private savedAt = Date.now();
  private broadcastAt = 0;
  private sentRevision = -1;
  private campaignSentAt = 0;
  private fault = false;
  constructor(readonly room: Room, private save: (state: WorldState) => Promise<void>) {}
  schedule(work: () => Promise<void>): Promise<void> { const task = this.queue.then(work); this.queue = task.catch(() => {}); return task; }
  async commit(): Promise<void> {
    if (this.fault) throw new Error('Сохранение временно недоступно.');
    try { await this.save(this.room.export()); this.room.dirty = false; this.savedAt = Date.now(); }
    catch { this.fault = true; this.stop(); for (const peer of this.peers.keys()) { this.send(peer, { type: 'error', message: 'Сохранение недоступно. Мир остановлен; переподключись позже.' }); peer.close(1011, 'Storage unavailable'); } throw new Error('Storage unavailable'); }
  }
  send(peer: Peer, message: ServerMessage): void { try { peer.send(JSON.stringify(message)); } catch { /* Close handling removes failed transports. */ } }
  message(peer: Peer, text: string): Promise<void> {
    return this.schedule(async () => {
      if (this.fault) { peer.close(1011, 'Storage unavailable'); return; }
      if (text.length > 16384) { peer.close(1009, 'Message too large'); return; }
      let operation: string | undefined;
      try {
        const message = messageSchema.parse(JSON.parse(text));
        if (message.type === 'hello') {
          if (this.peers.has(peer)) { peer.close(1008, 'Already authenticated'); return; }
          const player = await this.room.join(message.key, message.invite, message.name);
          for (const [old, id] of this.peers) if (id === player.id && old !== peer) { this.peers.delete(old); old.close(4001, 'Opened on another device'); }
          this.peers.set(peer, player.id); await this.commit();
          this.send(peer, { type: 'welcome', version: PROTOCOL, playerId: player.id, roomId: this.room.id, campaign: this.room.campaign, actors: this.room.frames(), tick: this.room.tick, revision: this.room.revision });
          this.start(); this.broadcast(true); return;
        }
        const id = this.peers.get(peer); if (!id) { peer.close(1008, 'Authenticate first'); return; }
        if (message.type === 'input') this.room.input(id, message.seq, message.controls);
        else if (message.type === 'ping') { this.room.ping(id, message.label); if (this.room.dirty) await this.commit(); }
        else {
          operation = message.id; this.room.command(id, message.id, message.command); await this.commit();
          this.broadcast(true); this.send(peer, { type: 'ack', id: message.id, revision: this.room.revision });
        }
      } catch (error) { this.send(peer, { type: 'error', message: error instanceof Error && !('issues' in error) ? error.message : 'Команда не принята. Обнови страницу.', id: operation }); }
    });
  }
  disconnect(peer: Peer): Promise<void> {
    return this.schedule(async () => {
      const id = this.peers.get(peer); this.peers.delete(peer);
      if (id && ![...this.peers.values()].includes(id)) { this.room.leave(id); if (!this.fault) await this.commit(); }
      if (!this.peers.size) this.stop(); else this.broadcast(true);
    });
  }
  private start(): void {
    if (this.timer) return;
    this.previous = Date.now();
    this.timer = setInterval(() => { void this.schedule(async () => {
      if (this.fault || !this.peers.size) return;
      const now = Date.now(), steps = Math.min(15, Math.max(0, Math.floor((now - this.previous) / (1000 / 60))));
      this.previous = now - ((now - this.previous) % (1000 / 60));
      for (let i = 0; i < steps; i++) this.room.step();
      if (this.room.dirty || now - this.savedAt >= 5000) await this.commit();
      if (now - this.broadcastAt >= 95) { this.broadcastAt = now; this.broadcast(false); }
    }).catch(() => {}); }, 100);
  }
  private broadcast(force: boolean): void {
    const changed = force || this.sentRevision !== this.room.revision || Date.now() - this.campaignSentAt >= 5000;
    if (changed) this.campaignSentAt = Date.now();
    const message: ServerMessage = { type: 'frame', actors: this.room.frames(), tick: this.room.tick, revision: this.room.revision, events: this.room.events.splice(0), pings: this.room.pings, ...(changed ? { campaign: this.room.campaign } : {}) };
    this.sentRevision = this.room.revision;
    for (const peer of this.peers.keys()) this.send(peer, message);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
