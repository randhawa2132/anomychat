import { storageKey } from "./events";

const preferenceKey = storageKey("call-ringtone-v1");
let audio: AudioContext | null = null;
let timer: number | null = null;
const activeGains = new Set<GainNode>();

export function ringtoneEnabled(): boolean {
  return localStorage.getItem(preferenceKey) !== "off";
}

export function setRingtoneEnabled(enabled: boolean): void {
  localStorage.setItem(preferenceKey, enabled ? "on" : "off");
  if (!enabled) stopRingtone();
}

export function primeRingtone(): void {
  if (typeof AudioContext === "undefined") return;
  try {
    audio ||= new AudioContext();
    if (audio.state === "suspended") void audio.resume().catch(() => {});
  } catch { /* The incoming call will still show its answer controls. */ }
}

function pulse(at: number): void {
  if (!audio) return;
  for (const [frequency, volume] of [[440, 0.065], [660, 0.025]]) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.025);
    gain.gain.setValueAtTime(volume, at + 0.19);
    gain.gain.linearRampToValueAtTime(0, at + 0.28);
    oscillator.connect(gain).connect(audio.destination);
    activeGains.add(gain);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); activeGains.delete(gain); };
    oscillator.start(at);
    oscillator.stop(at + 0.29);
  }
}

function ring(): void {
  if (!audio || audio.state !== "running") return;
  const now = audio.currentTime + 0.01;
  pulse(now);
  pulse(now + 0.48);
}

export async function startRingtone(): Promise<boolean> {
  if (!ringtoneEnabled() || typeof AudioContext === "undefined") return false;
  primeRingtone();
  if (!audio) return false;
  if (audio.state !== "running") {
    await Promise.race([audio.resume().catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 350))]);
  }
  if (audio.state !== "running") return false;
  stopRingtone();
  ring();
  timer = window.setInterval(ring, 2400);
  return true;
}

export function stopRingtone(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (!audio) return;
  for (const gain of activeGains) {
    gain.gain.cancelScheduledValues(audio.currentTime);
    gain.gain.setValueAtTime(0, audio.currentTime);
  }
}
