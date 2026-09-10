import { Terrain } from './world';
import type { Simulation } from './simulation';

export class Soundscape {
  enabled = true;
  volume = .65;
  musicVolume = .55;
  private ctx?: AudioContext;
  private effects?: GainNode;
  private musicGain?: GainNode;
  private musicFilter?: BiquadFilterNode;
  private windGain?: GainNode;
  private groundGain?: GainNode;
  private groundFilter?: BiquadFilterNode;
  private noise?: AudioBuffer;
  private engine?: OscillatorNode;
  private engineGain?: GainNode;
  private reverb?: GainNode;
  private paused = false;
  private hidden = false;
  private terrain: number = Terrain.Meadow;
  private musicReady = false;

  constructor(readonly music: HTMLAudioElement) {
    music.src = '/audio/machina-game.mp3';
    music.loop = true; music.preload = 'none';
    music.addEventListener('playing', () => { music.dataset.state = 'playing'; });
    music.addEventListener('error', () => { music.dataset.state = 'unavailable'; });
    music.addEventListener('waiting', () => { music.dataset.state = 'loading'; });
  }
  async start(): Promise<void> {
    if (!this.enabled) return;
    try {
      if (!this.ctx) this.build();
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
      this.syncVolume();
      if (!this.hidden && this.musicVolume > 0 && this.music.paused) {
        this.music.dataset.state = 'loading';
        await this.music.play(); this.musicReady = true;
      }
    } catch { this.music.dataset.state = 'tap-to-play'; }
  }
  private build(): void {
    const ctx = this.ctx = new AudioContext();
    const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -12; limiter.knee.value = 16; limiter.ratio.value = 4; limiter.connect(ctx.destination);
    this.effects = ctx.createGain(); this.effects.connect(limiter);
    this.musicGain = ctx.createGain(); this.musicGain.gain.value = 0; this.musicGain.connect(limiter);
    this.musicFilter = ctx.createBiquadFilter(); this.musicFilter.type = 'lowpass'; this.musicFilter.frequency.value = 12000; this.musicFilter.Q.value = .2; this.musicFilter.connect(this.musicGain);
    ctx.createMediaElementSource(this.music).connect(this.musicFilter);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const noise = this.noise.getChannelData(0); let previous = 0;
    for (let i = 0; i < noise.length; i++) { previous = (previous + (Math.random() * 2 - 1) * .04) / 1.04; noise[i] = previous * 5; }
    const convolver = ctx.createConvolver(), impulse = ctx.createBuffer(2, ctx.sampleRate * 1.5, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3) * .4;
    }
    convolver.buffer = impulse; this.reverb = ctx.createGain(); this.reverb.gain.value = .14; convolver.connect(this.reverb); this.reverb.connect(this.effects);
    this.wet = convolver;
    this.engine = ctx.createOscillator(); this.engine.type = 'triangle'; this.engine.frequency.value = 42;
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0; this.engine.connect(this.engineGain); this.engineGain.connect(this.effects); this.engine.start();
    const wind = ctx.createBufferSource(), windFilter = ctx.createBiquadFilter();
    wind.buffer = this.noise; wind.loop = true; windFilter.type = 'lowpass'; windFilter.frequency.value = 700;
    this.windGain = ctx.createGain(); this.windGain.gain.value = .04;
    wind.connect(windFilter); windFilter.connect(this.windGain); this.windGain.connect(this.effects); wind.start();
    const ground = ctx.createBufferSource(); ground.buffer = this.noise; ground.loop = true;
    this.groundFilter = ctx.createBiquadFilter(); this.groundFilter.type = 'bandpass';
    this.groundGain = ctx.createGain(); this.groundGain.gain.value = 0;
    ground.connect(this.groundFilter); this.groundFilter.connect(this.groundGain); this.groundGain.connect(this.effects); ground.start();
  }
  private wet?: ConvolverNode;
  setPaused(value: boolean): void { this.paused = value; this.syncVolume(); }
  setHidden(value: boolean): void {
    this.hidden = value;
    if (value) this.music.pause(); else if (this.musicReady && this.enabled && this.musicVolume > 0) void this.start();
    this.syncVolume();
  }
  syncVolume(): void {
    if (!this.ctx) return;
    const audible = this.enabled && !this.hidden;
    this.effects?.gain.setTargetAtTime(audible && !this.paused ? this.volume * .6 : 0, this.ctx.currentTime, .12);
    this.musicGain?.gain.setTargetAtTime(audible ? this.musicVolume * (this.paused ? .26 : .6) : 0, this.ctx.currentTime, .65);
    if (!audible || this.musicVolume === 0) this.music.pause();
  }
  updateScene(sim: Simulation): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.terrain = sim.world.at(sim.player.x, sim.player.y);
    const speed = Math.min(1, sim.car.speed / 140), moving = sim.driving && !sim.docked;
    this.engine?.frequency.setTargetAtTime(35 + sim.car.speed * .31 + (sim.car.boosting ? 12 : 0), t, .12);
    this.engineGain?.gain.setTargetAtTime(moving ? .024 + speed * .10 : 0, t, .12);
    const water = this.terrain === Terrain.Water, rough = [Terrain.Stone, Terrain.Mud, Terrain.Ash, Terrain.Sand].some(type => type === this.terrain);
    this.groundGain?.gain.setTargetAtTime(moving ? speed * (water ? .42 : rough ? .23 : .06) : 0, t, .25);
    this.groundFilter?.frequency.setTargetAtTime(water ? 1450 : this.terrain === Terrain.Ice ? 2100 : rough ? 390 : 700, t, .4);
    this.windGain?.gain.setTargetAtTime(sim.docked ? .015 : .04 + sim.storm * .65 + sim.night * .09, t, .8);
    this.musicFilter?.frequency.setTargetAtTime(sim.docked ? 8000 : 12000 - sim.storm * 6500 - sim.night * 1500, t, 1.4);
  }
  private tone(frequency: number, delay: number, duration: number, volume: number, type: OscillatorType = 'sine', pan = 0): void {
    if (!this.ctx || !this.effects || !this.enabled || this.paused || this.hidden) return;
    const time = this.ctx.currentTime + delay, osc = this.ctx.createOscillator(), gain = this.ctx.createGain(), stereo = this.ctx.createStereoPanner();
    osc.type = type; osc.frequency.value = frequency; stereo.pan.value = pan;
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(volume, time + .012); gain.gain.exponentialRampToValueAtTime(.001, time + duration);
    osc.connect(gain); gain.connect(stereo); stereo.connect(this.effects); if (this.wet) stereo.connect(this.wet);
    osc.start(time); osc.stop(time + duration + .03); osc.onended = () => { osc.disconnect(); gain.disconnect(); stereo.disconnect(); };
  }
  play(type: string): void {
    if (!this.enabled || this.hidden) return;
    if (type === 'ui') { this.tone(300, 0, .045, .035, 'triangle'); return; }
    if (type === 'upgrade') { [293.66, 440, 587.33].forEach((f, i) => this.tone(f, i * .075, .28, .1, 'triangle')); return; }
    if (type === 'pickup') { this.tone(587.33, 0, .18, .09); this.tone(880, .09, .25, .07); }
    else if (type === 'complete' || type === 'rescue') [293.66, 349.23, 440, 587.33].forEach((f, i) => this.tone(f, i * .11, .65, .09));
    else if (type === 'beacon') { this.tone(440, 0, .25, .09); this.tone(659.25, .14, .4, .07); }
    else if (type === 'full') { this.tone(392, 0, .16, .1); this.tone(293.66, .19, .3, .08); }
    else if (type === 'damage') { this.rustle(.16, .3, 650); this.tone(75, 0, .22, .13, 'triangle'); }
    else if (type === 'enter' || type === 'exit') { this.rustle(.055, .14, 350); this.tone(type === 'enter' ? 130 : 100, 0, .08, .06, 'triangle'); }
    else if (type === 'timeout') { this.tone(196, 0, .6, .1); this.tone(146.83, .25, 1, .08); }
    else if (type === 'wisp') { this.tone(659.25, 0, .22, .06); this.tone(880, .1, .3, .05); }
    else if (type === 'pulse') { this.tone(440, 0, .24, .05); this.tone(660, .16, .35, .035); }
    else if (type === 'dash') this.rustle(.18, .17, 1400);
    else if (type === 'step') this.rustle(.055, .07, this.terrain === Terrain.Stone ? 1100 : this.terrain === Terrain.Ice ? 1800 : 400);
    else if (type === 'water') this.rustle(.14, .18, 1650);
  }
  signal(strength: number, pan: number): void {
    this.tone(570 + strength * 300, 0, .07, .014 + strength * .025, 'sine', Math.max(-.8, Math.min(.8, pan)));
  }
  private rustle(duration: number, volume: number, frequency: number): void {
    if (!this.ctx || !this.effects || !this.noise || this.paused || !this.enabled || this.hidden) return;
    const source = this.ctx.createBufferSource(), gain = this.ctx.createGain(), filter = this.ctx.createBiquadFilter(), time = this.ctx.currentTime;
    source.buffer = this.noise; filter.type = 'bandpass'; filter.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, time); gain.gain.exponentialRampToValueAtTime(.001, time + duration);
    source.connect(filter); filter.connect(gain); gain.connect(this.effects); source.start(time, Math.random()); source.stop(time + duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  }
}
