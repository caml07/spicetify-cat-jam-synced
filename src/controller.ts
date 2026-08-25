import { computePlaybackRate } from "./tempo";
import { nextBeatDelaySeconds, Beat } from "./beats";

export interface AnalysisResult {
  tempoBpm?: number;
  beats?: Beat[];
}

export interface CatJamConfig {
  videoUrl: string;
  defaultBpm: number;
}

interface Deps {
  getConfig(): CatJamConfig;
  fetchAnalysis(uri: string): Promise<AnalysisResult | null>;
  nowMs?(): number;
}

const SEEK_THRESHOLD_MS = 500;

export function safePlay(video: HTMLVideoElement): void {
  // Autoplay denial or load failure: stay paused, never throw unhandled.
  const p = video.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

/**
 * Single owner of synchronization state: current track identity, analysis,
 * beat timers and the video element. All async results are guarded by a
 * generation counter so late responses can never overwrite a newer track.
 */
export class CatJamController {
  private video: HTMLVideoElement | null = null;
  private generation = 0;
  private tempoBpm: number | undefined;
  private beats: Beat[] | undefined;
  private beatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressMs = 0;

  constructor(private deps: Deps) {}

  setVideo(video: HTMLVideoElement | null): void {
    this.video = video;
    this.applyRate();
  }

  onSongChange(uri: string | undefined, progressMs = 0, isPlaying = true): void {
    this.generation++;
    this.clearBeatTimer();
    this.tempoBpm = undefined;
    this.beats = undefined;
    this.lastProgressMs = progressMs;

    if (!uri) return;
    if (this.video && isPlaying) safePlay(this.video);

    const gen = this.generation;
    void this.deps.fetchAnalysis(uri).then((result) => {
      if (gen !== this.generation) return; // stale: track changed meanwhile
      this.tempoBpm = result?.tempoBpm;
      this.beats = Array.isArray(result?.beats) ? result!.beats : undefined;
      this.applyRate();
      this.resync(progressMs, isPlaying);
    });
  }

  onPlayPause(isPlaying: boolean, progressMs = 0): void {
    this.clearBeatTimer();
    if (!isPlaying) {
      this.video?.pause();
      return;
    }
    this.resync(progressMs, true);
  }

  onProgress(progressMs: number, isPlaying = true): void {
    const jumped = Math.abs(progressMs - this.lastProgressMs) >= SEEK_THRESHOLD_MS;
    this.lastProgressMs = progressMs;
    if (jumped) {
      this.clearBeatTimer();
      this.resync(progressMs, isPlaying);
    }
  }

  private applyRate(): void {
    if (!this.video) return;
    this.video.playbackRate = computePlaybackRate(this.tempoBpm, this.deps.getConfig().defaultBpm);
  }

  private resync(progressMs: number, isPlaying: boolean): void {
    const video = this.video;
    if (!video || !isPlaying) return;
    const now = () => this.deps.nowMs?.() ?? Date.now();
    const startedAt = now();
    const delaySeconds = nextBeatDelaySeconds(this.beats ?? null, progressMs / 1000);
    this.clearBeatTimer();
    if (delaySeconds === null) {
      safePlay(video);
      return;
    }
    const elapsed = now() - startedAt;
    this.beatTimer = setTimeout(() => {
      this.beatTimer = null;
      video.currentTime = 0;
      safePlay(video);
    }, Math.max(0, delaySeconds * 1000 - elapsed));
  }

  private clearBeatTimer(): void {
    if (this.beatTimer !== null) {
      clearTimeout(this.beatTimer);
      this.beatTimer = null;
    }
  }
}
