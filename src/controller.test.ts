import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CatJamController,
  CatJamConfig,
  AnalysisResult,
  PlaybackState,
} from "./controller";

const CONFIG: CatJamConfig = { videoUrl: "http://x/cat.webm", defaultBpm: 135.48 };
const PLAYING: PlaybackState = { progressMs: 0, isPlaying: true };

function fakeVideo() {
  return {
    playbackRate: 1,
    currentTime: 1,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    isConnected: true,
  } as any;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("CatJamController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeController(fetchAnalysis: (uri: string) => Promise<AnalysisResult | null>) {
    return new CatJamController({ getConfig: () => CONFIG, fetchAnalysis });
  }

  it("stale analysis result cannot overwrite a newer track", async () => {
    const pendingA = deferred<AnalysisResult | null>();
    const c = makeController((uri) =>
      uri === "spotify:track:A" ? pendingA.promise : Promise.resolve({ tempoBpm: 270.96 })
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(1);

    c.onSongChange("spotify:track:B", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(2); // 270.96 / 135.48

    pendingA.resolve({ tempoBpm: 60 }); // late result for the OLD track
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(2); // unchanged by stale A
  });

  it("song change cancels pending beat timers of the previous track", async () => {
    const neverResolves = new Promise<AnalysisResult | null>(() => {});
    let track = "A";
    const c = makeController(() =>
      track === "A"
        ? Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 10 }] })
        : neverResolves
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0); // A's beat timer armed ~10s out

    track = "B";
    c.onSongChange("spotify:track:B", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    const playsNow = video.play.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(video.play.mock.calls.length).toBe(playsNow); // A's stale timer never fired
  });

  it("pause clears pending timers and pauses video", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 5 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    c.onPlayPause({ progressMs: 0, isPlaying: false });

    const plays = video.play.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(video.play.mock.calls.length).toBe(plays);
    expect(video.pause).toHaveBeenCalled();
  });

  it("resumes, resets alignment and resyncs on play", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 2 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);

    c.onPlayPause({ progressMs: 0, isPlaying: false });
    video.currentTime = 1;
    c.onPlayPause({ progressMs: 0, isPlaying: true });
    vi.advanceTimersByTime(2_000);
    expect(video.currentTime).toBe(0); // beat timer fired after resume
  });

  it("coalesces progress events: normal ticks keep state, seeks resync once", async () => {
    const c = makeController(() =>
      Promise.resolve({ tempoBpm: 135.48, beats: [{ start: 30 }] })
    );
    const video = fakeVideo();
    c.setVideo(video);
    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // one pending beat timer

    c.onProgress({ progressMs: 1_000, isPlaying: true });
    c.onProgress({ progressMs: 1_250, isPlaying: true });
    c.onProgress({ progressMs: 1_500, isPlaying: true });
    expect(vi.getTimerCount()).toBe(1); // ticks did not pile up timers

    c.onProgress({ progressMs: 40_000, isPlaying: true }); // seek past every known beat
    expect(vi.getTimerCount()).toBe(0); // stale beat timer dropped, none scheduled
  });

  it("seek with no upcoming beat restarts the loop aligned at zero", async () => {
    const c = makeController(() => Promise.resolve(null)); // no beats available
    const video = fakeVideo();
    video.currentTime = 3;
    c.setVideo(video);

    c.onProgress({ progressMs: 40_000, isPlaying: true });
    expect(video.currentTime).toBe(0);
    expect(video.play).toHaveBeenCalled();
  });

  it("falls back safely when analysis is unavailable", async () => {
    const c = makeController(() => Promise.resolve(null));
    const video = fakeVideo();
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0);
    expect(video.playbackRate).toBeCloseTo(1);
    expect(video.play).toHaveBeenCalled(); // cat keeps dancing without analysis
  });

  it("safePlay swallows play() rejections", async () => {
    const c = makeController(() => Promise.resolve({ tempoBpm: 135.48 }));
    const video = fakeVideo();
    video.play.mockRejectedValue(new Error("NotAllowedError"));
    c.setVideo(video);

    c.onSongChange("spotify:track:A", PLAYING);
    await vi.advanceTimersByTimeAsync(0); // no unhandled rejection escapes
    expect(video.play).toHaveBeenCalled();
  });

  it("no-ops safely without a mounted video", async () => {
    const c = makeController(() => Promise.resolve({ tempoBpm: 180 }));
    expect(() => {
      c.onSongChange("spotify:track:A", PLAYING);
      c.onPlayPause(PLAYING);
      c.onProgress(PLAYING);
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});
